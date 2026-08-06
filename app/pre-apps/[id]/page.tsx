import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ArrowLeftIcon, PencilIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  canEditPreApp,
  type PreApp,
  type PreAppBusinessProfile,
  type PreAppOwner,
  statusBadgeVariant,
} from "@/lib/pre-apps";
import { formatDate, formatPct, formatText } from "@/lib/format";
import { DOCUMENT_LIST_COLUMNS, type DocumentRow } from "@/lib/documents";
import { DocumentsPanel } from "@/components/documents-panel";
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
    <div className="flex flex-col gap-4">
      <h2 className="font-semibold text-lg">{title}</h2>
      <dl className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">{children}</dl>
    </div>
  );
}

async function PreAppDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await requireUser();
  const supabase = await createClient();

  const preAppId = Number(id);
  if (!Number.isInteger(preAppId)) {
    notFound();
  }

  const { data, error } = await supabase
    .from("pre_apps")
    .select("*")
    .eq("id", preAppId)
    .maybeSingle();

  // A pre-app that doesn't exist and one owned by another agent are both zero
  // rows here, and both 404 — distinguishing them would tell a probing agent
  // which pre-app ids exist.
  if (error || !data) {
    notFound();
  }

  const preApp = data as PreApp;
  const isAdmin = profile.role === "admin";

  const [{ data: ownerRows }, { data: profileRow }, { data: docRows }] =
    await Promise.all([
      supabase
        .from("pre_app_owners")
        .select("*")
        .eq("pre_app_id", preApp.id)
        .order("id"),
      supabase
        .from("pre_app_business_profile")
        .select("*")
        .eq("pre_app_id", preApp.id)
        .maybeSingle(),
      supabase
        .from("documents")
        .select(DOCUMENT_LIST_COLUMNS)
        .eq("owner_type", "pre_app")
        .eq("owner_id", preApp.id)
        .order("uploaded_at", { ascending: false }),
    ]);

  const owners = (ownerRows ?? []) as PreAppOwner[];
  const cardMix = (profileRow ?? null) as PreAppBusinessProfile | null;
  const documents = (docRows ?? []) as DocumentRow[];

  let agentName: string | null = null;
  if (isAdmin) {
    const { data: agent } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("id", preApp.agent_id)
      .maybeSingle();
    agentName = (agent?.full_name as string | undefined) ?? null;
  }

  const canEdit = canEditPreApp(preApp.status, isAdmin);

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">{preApp.dba_name}</h1>
            <Badge variant={statusBadgeVariant(preApp.status)}>
              {preApp.status}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {formatText(preApp.legal_business_name)}
          </p>
        </div>
        {canEdit ? (
          <Button asChild size="sm">
            <Link href={`/pre-apps/${preApp.id}/edit?step=business`}>
              <PencilIcon size={16} />
              Edit
            </Link>
          </Button>
        ) : (
          // Reps lose write access the moment it leaves draft. Saying so beats
          // a missing button they'd otherwise read as a bug. The enforcing
          // halves are the guard trigger and the RPCs, not this.
          <p className="text-sm text-muted-foreground max-w-[16rem] text-right">
            {preApp.status === "submitted"
              ? "Submitted for review — ask an admin to reopen it to make changes."
              : `This pre-app is ${preApp.status} and can no longer be edited.`}
          </p>
        )}
      </div>

      {preApp.decline_reason && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm dark:border-red-900 dark:bg-red-950">
          <p className="font-medium">Declined</p>
          <p className="text-muted-foreground">{preApp.decline_reason}</p>
        </div>
      )}

      <Section title="Business">
        <Field label="DBA">{preApp.dba_name}</Field>
        <Field label="Legal name">
          {formatText(preApp.legal_business_name)}
        </Field>
        <Field label="Contact">{formatText(preApp.contact_name)}</Field>
        <Field label="Contact phone">{formatText(preApp.contact_phone)}</Field>
        <Field label="Business phone">{formatText(preApp.phone_number)}</Field>
        <Field label="Email">{formatText(preApp.email_address)}</Field>
        <Field label="Address">{formatText(preApp.physical_address)}</Field>
        <Field label="City">{formatText(preApp.city)}</Field>
        <Field label="State">{formatText(preApp.state)}</Field>
        <Field label="ZIP">{formatText(preApp.zip)}</Field>
        <Field label="Website">{formatText(preApp.website)}</Field>
        <Field label="Entity type">{formatText(preApp.legal_entity_type)}</Field>
        <Field label="EIN">{formatText(preApp.ein_number)}</Field>
        <Field label="Started">{formatDate(preApp.business_start_date)}</Field>
        <Field label="Goods sold">{formatText(preApp.goods_sold)}</Field>
        <Field label="Bank">{formatText(preApp.bank_name)}</Field>
        <Field label="Billing">{formatText(preApp.billing_type)}</Field>
        <Field label="Split (agent / company)">
          {formatPct(preApp.split_agent_pct)} /{" "}
          {formatPct(preApp.split_company_pct)}
        </Field>
        {isAdmin && <Field label="Agent">{formatText(agentName)}</Field>}
      </Section>

      <div className="flex flex-col gap-4">
        <h2 className="font-semibold text-lg">Owners ({owners.length})</h2>
        {owners.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No owners recorded yet. At least one owner holding 51% or more is
            required before this can be submitted.
          </p>
        ) : (
          <div className="flex flex-col gap-6">
            {owners.map((owner) => (
              <dl
                key={owner.id}
                className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
              >
                <Field label="Name">{formatText(owner.owner_name)}</Field>
                <Field label="Title">{formatText(owner.title)}</Field>
                <Field label="Ownership">
                  {formatPct(owner.percent_owned)}
                </Field>
                <Field label="Home phone">{formatText(owner.home_phone)}</Field>
                <Field label="Date of birth">{formatDate(owner.dob)}</Field>
                <Field label="Home state">{formatText(owner.home_state)}</Field>
              </dl>
            ))}
          </div>
        )}
      </div>

      <Section title="Card mix">
        <Field label="Swiped">{formatPct(cardMix?.card_swiped_pct)}</Field>
        <Field label="Keyed">{formatPct(cardMix?.card_keyed_pct)}</Field>
        <Field label="Card present">
          {formatPct(cardMix?.card_present_pct)}
        </Field>
        <Field label="Card not present">
          {formatPct(cardMix?.card_not_present_pct)}
        </Field>
        <Field label="MOTO">{formatPct(cardMix?.moto_pct)}</Field>
        <Field label="Internet">{formatPct(cardMix?.internet_pct)}</Field>
      </Section>

      <DocumentsPanel
        ownerType="pre_app"
        ownerId={preApp.id}
        documents={documents}
      />
    </>
  );
}

export default function PreAppDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <div className="flex-1 w-full flex flex-col gap-8 p-6 md:p-10 max-w-5xl mx-auto">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/pre-apps">
          <ArrowLeftIcon size={16} />
          Back to pre-apps
        </Link>
      </Button>

      {/* params stays unawaited here — awaiting it outside Suspense is what
          cacheComponents rejects at build time. */}
      <Suspense
        fallback={<p className="text-sm text-muted-foreground">Loading…</p>}
      >
        <PreAppDetail params={params} />
      </Suspense>
    </div>
  );
}
