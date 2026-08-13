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
  type PreAppTerminal,
  statusIntent,
} from "@/lib/pre-apps";
import { formatText } from "@/lib/format";
import { DOCUMENT_LIST_COLUMNS, type DocumentRow } from "@/lib/documents";
import { loadAnnotations } from "@/lib/annotations-data";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { DocumentsPanel } from "@/components/documents-panel";
import { NotesPanel } from "@/components/notes-panel";
import { TasksPanel } from "@/components/tasks-panel";
import { PreAppDecision } from "@/components/pre-app-decision";
import { PreAppSummary } from "@/components/pre-app-summary";
import { Callout } from "@/components/callout";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";

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

  const [
    { data: ownerRows },
    { data: profileRow },
    { data: terminalRow },
    { data: docRows },
  ] = await Promise.all([
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
      .from("pre_app_terminal")
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
  const terminal = (terminalRow ?? null) as PreAppTerminal | null;
  const documents = (docRows ?? []) as DocumentRow[];

  // The merchant this was approved into, if it has been. Looked up from the
  // merchant side because that is where the pointer lives, and read under the
  // caller's own policies — a rep sees their own merchant, an admin sees any.
  let approvedMerchant: { id: number; dba: string } | null = null;
  if (preApp.status === "approved") {
    const { data: merchantRow } = await supabase
      .from("merchants")
      .select("id, dba")
      .eq("pre_app_id", preApp.id)
      .maybeSingle();
    approvedMerchant = (merchantRow ?? null) as { id: number; dba: string } | null;
  }

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

  // owner_type is a literal here, never from the URL: owner_id has no foreign
  // key, so a mismatched pair is not something the database would catch.
  const { notes, tasks } = await loadAnnotations("pre_app", preApp.id);

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {preApp.dba_name}
            <StatusBadge intent={statusIntent(preApp.status)}>
              {preApp.status}
            </StatusBadge>
          </span>
        }
        subtitle={formatText(preApp.legal_business_name)}
        action={
          canEdit ? (
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
            //
            // Each status gets its own sentence because the way back differs: a
            // declined pre-app has one (reopen, below, which reps may do
            // themselves), a submitted one does not — reopen_pre_app requires
            // 'declined', so not even an admin can return this to draft; they
            // edit it in place or decline it. Approval is terminal.
            <p className="max-w-[16rem] text-right text-sm text-muted-foreground">
              {preApp.status === "submitted" &&
                "Submitted for review — only an admin can change it now."}
              {preApp.status === "declined" &&
                "Declined — reopen it below to make changes and submit again."}
              {preApp.status === "approved" &&
                "Approved, and no longer editable. Its merchant record carries on from here."}
            </p>
          )
        }
      />

      {preApp.decline_reason && (
        <Callout tone="danger" className="p-4">
          {/* reopen_pre_app deliberately leaves decline_reason in place so it
              stays on screen while the rep fixes it, and submit_pre_app clears
              it. So this banner outlives the declined status by design, and must
              not still read "Declined" over a row the badge calls a draft. */}
          <p className="font-medium">
            {preApp.status === "declined" ? "Declined" : "Previously declined"}
          </p>
          <p className="text-muted-foreground">{preApp.decline_reason}</p>
          {preApp.status === "draft" && (
            <p className="mt-2 text-muted-foreground">
              This note clears when the pre-app is submitted again.
            </p>
          )}
        </Callout>
      )}

      {/* Where an approved application ended up. Without this an approved
          pre-app was a dead end: it created a merchant and then gave no way to
          reach it. The null case is real — merchants approved before
          20260813162634 recorded no pointer — so this says so rather than
          rendering a broken link. */}
      {preApp.status === "approved" && (
        <Callout tone="success" className="p-4">
          <p className="font-medium">Approved</p>
          {approvedMerchant === null ? (
            <p className="text-muted-foreground">
              The merchant created from this application is not linked to it.
              Approvals only started recording the link recently.
            </p>
          ) : (
            <p className="text-muted-foreground">
              Merchant{" "}
              <Link
                href={`/merchants/${approvedMerchant.id}`}
                className="underline underline-offset-4"
              >
                {approvedMerchant.dba}
              </Link>{" "}
              was created from this. Its details were copied across at approval
              — editing this application does not change it.
            </p>
          )}
        </Callout>
      )}

      {/* Renders nothing on a draft, or on anything an admin has already
          approved — see the component. */}
      <PreAppDecision
        preAppId={preApp.id}
        status={preApp.status}
        isAdmin={isAdmin}
        agentName={agentName}
      />

      {/* Shared with the wizard's review step, so what a rep sees before
          submitting and what an admin sees before approving cannot drift. */}
      <PreAppSummary
        preApp={preApp}
        owners={owners}
        terminal={terminal}
        cardMix={cardMix}
        agentName={isAdmin ? agentName : undefined}
      />

      <TasksPanel
        ownerType="pre_app"
        ownerId={preApp.id}
        tasks={tasks}
        agentId={profile.id}
        isAdmin={isAdmin}
      />

      <NotesPanel
        ownerType="pre_app"
        ownerId={preApp.id}
        notes={notes}
        agentId={profile.id}
        isAdmin={isAdmin}
      />

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
    <PageShell width="detail">
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
    </PageShell>
  );
}
