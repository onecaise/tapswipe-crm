import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import {
  ArrowLeftIcon,
  FilePlusIcon,
  FileTextIcon,
  PencilIcon,
} from "lucide-react";

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  LEAD_STATUS_LABELS,
  type Lead,
  isLeadStatus,
  statusIntent,
} from "@/lib/leads";
import { formatDate, formatStatus, formatText } from "@/lib/format";
import { DOCUMENT_LIST_COLUMNS, type DocumentRow } from "@/lib/documents";
import {
  EVENT_COLUMNS,
  MATERIAL_LIST_COLUMNS,
  type MarketingEvent,
  type MarketingMaterial,
  hasFile,
} from "@/lib/marketing-materials";
import { PRODUCT_COLUMNS, type Product, isQuotable } from "@/lib/products";
import {
  QUOTE_COLUMNS,
  QUOTE_LINE_COLUMNS,
  type Quote,
  type QuoteLineItem,
  groupQuotes,
} from "@/lib/quotes";
import { loadAnnotations } from "@/lib/annotations-data";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { DocumentsPanel } from "@/components/documents-panel";
import { MarketingPanel } from "@/components/marketing-panel";
import { NotesPanel } from "@/components/notes-panel";
import { QuotesPanel } from "@/components/quotes-panel";
import { TasksPanel } from "@/components/tasks-panel";
import { StatusBadge } from "@/components/status-badge";
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

  // Whether an application already came off this lead. pre_apps.lead_id records
  // provenance and is deliberately not unique — a lead can legitimately be
  // applied for more than once — so this is not a constraint, it is the thing
  // the page was missing. "Start pre-app" was shown unconditionally with no
  // sign that one already existed, so the obvious move on a lead already in
  // flight was to quietly start a second one.
  const { data: existingPreApp } = await supabase
    .from("pre_apps")
    .select("id, status")
    .eq("lead_id", lead.id)
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  const preApp = (existingPreApp ?? null) as {
    id: number;
    status: string;
  } | null;

  // owner_type is a literal here, never from the URL: owner_id has no foreign
  // key, so a mismatched pair is not something the database would catch.
  const { notes, tasks } = await loadAnnotations("lead", lead.id);

  // The marketing library, and what has already been sent to THIS lead.
  //
  // Two queries rather than one join, because they are scoped by two different
  // policies and the difference matters: materials are readable by every active
  // user (company reference data, no agent_id), while events are own-or-admin.
  // A rep therefore sees the whole library and only their own trail; an admin
  // sees the whole library and everyone's trail on this lead. Expressing that
  // as an embedded select would make the scoping depend on PostgREST's join
  // semantics rather than on two policies that each say what they mean.
  const [{ data: materialRows }, { data: eventRows }] = await Promise.all([
    supabase
      .from("marketing_materials")
      .select(MATERIAL_LIST_COLUMNS)
      .is("archived_at", null)
      .order("category", { ascending: true })
      .order("title", { ascending: true }),
    supabase
      .from("marketing_material_events")
      .select(EVENT_COLUMNS)
      .eq("lead_id", lead.id)
      .order("occurred_at", { ascending: false })
      .limit(50),
  ]);

  // Unfinished uploads are hidden from reps: every action on one would 409.
  // /marketing/manage is where they are visible, because fixing one is admin
  // work.
  const allMaterials = (materialRows ?? []) as MarketingMaterial[];
  const materials = allMaterials.filter(hasFile);
  const marketingEvents = (eventRows ?? []) as MarketingEvent[];

  // Built from the UNFILTERED list, so the history can still name a material
  // whose upload never finished — or, once archiving is used in anger, one that
  // has since been retired. That is the whole reason archiving exists instead
  // of deleting, and a history reading "A material" where a title should be
  // would quietly give it away.
  const materialTitles = new Map(
    allMaterials.map((material) => [material.id, material.title]),
  );

  // Quotes on this lead, every version of every one of them, plus the catalog
  // the builder picks from.
  //
  // EVERY version, not just the current one, and that is the point of the
  // append-only design rather than an over-fetch: the history view renders
  // superseded versions in full, with their own snapshotted prices. "Which
  // version is current" is then decided in one place — groupQuotes(), which
  // calls currentVersion() — because the database stores no is_current flag,
  // only the uniqueness that makes "highest version" unambiguous.
  //
  // Both reads are scoped by their own policies: quotes is own-or-admin, and
  // quote_line_items reaches the same answer through an `exists` on its
  // parent quote. Two queries rather than an embedded select, for the reason
  // the marketing pair above uses two — the scoping should be two policies
  // each saying what they mean, not PostgREST's join semantics.
  const { data: quoteRows } = await supabase
    .from("quotes")
    .select(QUOTE_COLUMNS)
    .eq("lead_id", lead.id)
    .order("created_at", { ascending: false })
    .order("version", { ascending: false });
  const quotes = (quoteRows ?? []) as Quote[];

  const quoteIds = quotes.map((quote) => quote.id);
  const { data: lineRows } = quoteIds.length
    ? await supabase
        .from("quote_line_items")
        .select(QUOTE_LINE_COLUMNS)
        .in("quote_id", quoteIds)
        .order("sort_order", { ascending: true })
    : { data: [] };

  const linesByQuote: Record<number, QuoteLineItem[]> = {};
  for (const line of (lineRows ?? []) as QuoteLineItem[]) {
    (linesByQuote[line.quote_id] ??= []).push(line);
  }

  // Only what can actually go on a quote: live, and priced. An unpriced
  // product is legitimate in the catalog ("call for pricing") and is refused
  // by create_quote_version(), so offering it in the picker would be offering
  // a choice that fails on save. The admin page is where that is visible and
  // fixable.
  const { data: productRows } = await supabase
    .from("products")
    .select(PRODUCT_COLUMNS)
    .is("archived_at", null)
    .order("category", { ascending: true })
    .order("name", { ascending: true });
  const products = ((productRows ?? []) as Product[]).filter(isQuotable);

  return (
    <>
      <PageHeader
        title={formatText(lead.dba)}
        action={
          <div className="flex items-center gap-2">
            {/* The lead's own fields ride across, so this is the path a rep
                should take rather than /pre-apps/new — see
                preAppDefaultsFromLead. */}
            <Button asChild size="sm" variant="outline">
              {preApp === null ? (
                <Link href={`/pre-apps/new?lead=${lead.id}`}>
                  <FilePlusIcon size={16} />
                  Start pre-app
                </Link>
              ) : (
                <Link href={`/pre-apps/${preApp.id}`}>
                  <FileTextIcon size={16} />
                  View pre-app
                </Link>
              )}
            </Button>
            <Button asChild size="sm">
              <Link href={`/leads/${lead.id}/edit`}>
                <PencilIcon size={16} />
                Edit
              </Link>
            </Button>
          </div>
        }
      >
        <div className="mt-1 flex items-center gap-2">
          {/* The vocabulary maps to the three shared intents — see statusIntent
              in lib/leads.ts, and note `lost` is grey rather than red: a status
              badge never wears brand or destructive colour. A value outside the
              vocabulary (a row predating the NOT VALID constraint) renders raw
              and neutral rather than crashing on a missing label. */}
          <StatusBadge intent={statusIntent(lead.status)}>
            {isLeadStatus(lead.status)
              ? LEAD_STATUS_LABELS[lead.status]
              : formatStatus(lead.status)}
          </StatusBadge>
          {lead.next_followup_date && (
            <span className="text-sm text-muted-foreground">
              Follow up {formatDate(lead.next_followup_date)}
            </span>
          )}
        </div>
      </PageHeader>

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
        <Field label="Website">{formatText(lead.website)}</Field>
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
        {/* The badge in the header capitalises through CSS, so this rendered
            the same value in a second casing right below it. */}
        <Field label="Stage">
          {isLeadStatus(lead.status)
            ? LEAD_STATUS_LABELS[lead.status]
            : formatStatus(lead.status)}
        </Field>
        {/* Shown only when it applies. leads_lost_reason_required guarantees a
            lost lead has one, so an empty "Lost reason" field would only ever
            appear on rows that predate the constraint — and on every other lead
            it would be a permanently blank row in the grid. */}
        {lead.status === "lost" && (
          <Field label="Lost reason">{formatText(lead.lost_reason)}</Field>
        )}
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

      <QuotesPanel
        leadId={lead.id}
        agentId={lead.agent_id}
        groups={groupQuotes(quotes)}
        linesByQuote={linesByQuote}
        products={products}
      />

      <MarketingPanel
        materials={materials}
        events={marketingEvents}
        materialTitles={materialTitles}
        leadId={lead.id}
        agentId={profile.id}
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
    <PageShell width="detail">
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
    </PageShell>
  );
}
