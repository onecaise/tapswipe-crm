import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ArrowLeftIcon, PencilIcon, PrinterIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { type Merchant, statusIntent } from "@/lib/merchants";
import { formatDate, formatPct, formatText } from "@/lib/format";
import { DOCUMENT_LIST_COLUMNS, type DocumentRow } from "@/lib/documents";
import { loadAnnotations } from "@/lib/annotations-data";
import { groupQuotes } from "@/lib/quotes";
import { loadQuoteContext } from "@/lib/quotes-data";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { DocumentsPanel } from "@/components/documents-panel";
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

async function MerchantDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const profile = await requireUser();
  const supabase = await createClient();

  const merchantId = Number(id);
  if (!Number.isInteger(merchantId)) {
    notFound();
  }

  const { data, error } = await supabase
    .from("merchants")
    .select("*")
    .eq("id", merchantId)
    .maybeSingle();

  // A merchant that doesn't exist and one owned by another agent are both zero
  // rows here, and both 404. That's deliberate: distinguishing them (403 vs 404)
  // would tell a probing agent which merchant ids exist.
  if (error || !data) {
    notFound();
  }

  const merchant = data as Merchant;

  let agentName: string | null = null;
  if (profile.role === "admin") {
    const { data: agent } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("id", merchant.agent_id)
      .maybeSingle();
    agentName = (agent?.full_name as string | undefined) ?? null;
  }

  // Tier 1 read, scoped by the documents select policy.
  const { data: docs } = await supabase
    .from("documents")
    .select(DOCUMENT_LIST_COLUMNS)
    .eq("owner_type", "merchant")
    .eq("owner_id", merchant.id)
    .order("uploaded_at", { ascending: false });
  const documents = (docs ?? []) as DocumentRow[];

  // owner_type is a literal here, never from the URL: owner_id has no foreign
  // key, so a mismatched pair is not something the database would catch.
  const { notes, tasks } = await loadAnnotations("merchant", merchant.id);

  // The same loader the lead page uses. `quotes.merchant_id` DOES carry a
  // foreign key, unlike notes and tasks above — so a forged id here would be
  // refused by the database rather than merely unvalidated — but the literal
  // is passed for the same reason anyway: the page's correctness should not
  // depend on a policy clause somebody could decide looks redundant.
  const { quotes, linesByQuote, devices, addons, addonsByDevice } =
    await loadQuoteContext("merchant", merchant.id);

  return (
    <>
      <PageHeader
        title={merchant.dba}
        action={
          <div className="flex items-center gap-2">
            {/* Secondary: printing a record is occasional, editing it is not. */}
            <Button asChild size="sm" variant="outline">
              <Link href={`/merchants/${merchant.id}/print`}>
                <PrinterIcon size={16} />
                Print
              </Link>
            </Button>
            <Button asChild size="sm">
              <Link href={`/merchants/${merchant.id}/edit`}>
                <PencilIcon size={16} />
                Edit
              </Link>
            </Button>
          </div>
        }
      >
        <div className="mt-1 flex items-center gap-2">
          <StatusBadge intent={statusIntent(merchant.status)}>
            {merchant.status}
          </StatusBadge>
          {merchant.mid && (
            <span className="text-sm text-muted-foreground">
              MID {merchant.mid}
            </span>
          )}
        </div>
      </PageHeader>

      <dl className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Legal business name">
          {formatText(merchant.legal_business_name)}
        </Field>
        <Field label="MID">{formatText(merchant.mid)}</Field>
        <Field label="Processor">{formatText(merchant.processor)}</Field>
        <Field label="Agent split">{formatPct(merchant.split_agent_pct)}</Field>
        <Field label="Company split">
          {formatPct(merchant.split_company_pct)}
        </Field>
        <Field label="Date added">{formatDate(merchant.date_added)}</Field>
        {agentName !== null && <Field label="Agent">{agentName}</Field>}
        <Field label="Last updated">{formatDate(merchant.updated_at)}</Field>
        {/* Only when this merchant was approved from one. Merchants created by
            hand, and everything approved before 20260813162634, have nothing to
            point at. */}
        {merchant.pre_app_id !== null && (
          <Field label="Approved from">
            <Link
              href={`/pre-apps/${merchant.pre_app_id}`}
              className="underline underline-offset-4"
            >
              Pre-app #{merchant.pre_app_id}
            </Link>
          </Field>
        )}
      </dl>

      <TasksPanel
        ownerType="merchant"
        ownerId={merchant.id}
        tasks={tasks}
        agentId={profile.id}
        isAdmin={profile.role === "admin"}
      />

      <NotesPanel
        ownerType="merchant"
        ownerId={merchant.id}
        notes={notes}
        agentId={profile.id}
        isAdmin={profile.role === "admin"}
      />

      <DocumentsPanel
        ownerType="merchant"
        ownerId={merchant.id}
        documents={documents}
      />

      {/* The same panel the lead page mounts, with ownerType a LITERAL here
          too — never from the URL. A quote belongs to a lead OR a merchant
          (quotes_exactly_one_owner), and the merchant case is the one that
          made the column nullable: a rep sells hardware to win a deal, and
          sells more to the same business two years later when it is on the
          books. One table, one version history, one printable document.

          agent_id is the MERCHANT's owner rather than the viewer, so an admin
          building on a rep's behalf leaves the proposal in the rep's book. */}
      <QuotesPanel
        ownerType="merchant"
        ownerId={merchant.id}
        agentId={merchant.agent_id}
        groups={groupQuotes(quotes)}
        linesByQuote={linesByQuote}
        devices={devices}
        addons={addons}
        addonsByDevice={addonsByDevice}
      />
    </>
  );
}

export default function MerchantDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // params is passed down unawaited on purpose. Awaiting it here would put
  // dynamic data access outside the Suspense boundary, which cacheComponents
  // rejects at build time. Same shape as app/auth/error/page.tsx.
  return (
    <PageShell width="detail">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/merchants">
          <ArrowLeftIcon size={16} />
          Back to merchants
        </Link>
      </Button>

      <Suspense
        fallback={<p className="text-sm text-muted-foreground">Loading…</p>}
      >
        <MerchantDetail params={params} />
      </Suspense>
    </PageShell>
  );
}
