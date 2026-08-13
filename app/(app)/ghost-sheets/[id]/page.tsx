import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ArrowLeftIcon, PencilIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  conversionIntent,
  type GhostSheet,
  isConverted,
} from "@/lib/ghost-sheets";
import { formatDate, formatText } from "@/lib/format";
import { loadAnnotations } from "@/lib/annotations-data";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { ConvertGhostSheetButton } from "@/components/convert-ghost-sheet-button";
import { NotesPanel } from "@/components/notes-panel";
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

async function GhostSheetDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const profile = await requireUser();
  const supabase = await createClient();

  const sheetId = Number(id);
  if (!Number.isInteger(sheetId)) {
    notFound();
  }

  const { data, error } = await supabase
    .from("ghost_sheets")
    .select("*")
    .eq("id", sheetId)
    .maybeSingle();

  // Missing and not-owned are both zero rows under RLS, and both 404 — so ids
  // can't be probed for existence.
  if (error || !data) {
    notFound();
  }

  const sheet = data as GhostSheet;
  const converted = isConverted(sheet);

  let agentName: string | null = null;
  if (profile.role === "admin") {
    const { data: agent } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("id", sheet.agent_id)
      .maybeSingle();
    agentName = (agent?.full_name as string | undefined) ?? null;
  }

  // owner_type is a literal here, never from the URL: owner_id has no foreign
  // key, so a mismatched pair is not something the database would catch.
  const { notes, tasks } = await loadAnnotations("ghost_sheet", sheet.id);

  return (
    <>
      <PageHeader
        title={formatText(sheet.dba)}
        action={
          <Button asChild size="sm" variant="outline">
            <Link href={`/ghost-sheets/${sheet.id}/edit`}>
              <PencilIcon size={16} />
              Edit
            </Link>
          </Button>
        }
      >
        {/* The badge is the derived conversion state (does this sheet have a
            lead_id yet); sheet.status is the column a rep sets by hand. They
            usually read the same, so showing the raw value bare next to the
            badge looked like the status had been printed twice. Labelled, so
            the two are legible as the different things they are. */}
        <div className="mt-1 flex items-center gap-2">
          <StatusBadge intent={conversionIntent(sheet)}>
            {converted ? "converted" : "open"}
          </StatusBadge>
          <span className="text-sm text-muted-foreground">
            Marked {formatText(sheet.status)}
          </span>
        </div>
      </PageHeader>

      <dl className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Contact name">{formatText(sheet.contact_name)}</Field>
        <Field label="Contact phone">{formatText(sheet.contact_phone)}</Field>
        <Field label="Created">{formatDate(sheet.created_at)}</Field>
        {agentName !== null && <Field label="Agent">{agentName}</Field>}
        {/* No "last updated": ghost_sheets has no updated_at column, so showing
            one would mean inventing a value. */}
      </dl>

      {/* "Intake notes", not "Notes": this is ghost_sheets.notes — one text
          column captured when the sheet was written down, and the thing
          convert_ghost_sheet_to_lead copies onto the new lead. The Notes panel
          below is the polymorphic notes table, which is a different thing with
          many rows. Two sections both called Notes on one page would be a
          genuine trap. */}
      <div className="flex flex-col gap-2">
        <h2 className="font-semibold text-lg">Intake notes</h2>
        <p className="text-sm whitespace-pre-wrap">
          {formatText(sheet.notes)}
        </p>
      </div>

      {converted ? (
        <div className="flex flex-col gap-2 items-start">
          <h2 className="font-semibold text-lg">Converted lead</h2>
          <Button asChild variant="outline" size="sm">
            <Link href={`/leads/${sheet.lead_id}`}>View lead</Link>
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2 items-start">
          <h2 className="font-semibold text-lg">Convert</h2>
          <p className="text-sm text-muted-foreground">
            Creates a lead in{" "}
            {profile.role === "admin" ? "this sheet's agent's" : "your"} book and
            copies these notes onto it.
          </p>
          <ConvertGhostSheetButton ghostSheetId={sheet.id} />
        </div>
      )}

      <TasksPanel
        ownerType="ghost_sheet"
        ownerId={sheet.id}
        tasks={tasks}
        agentId={profile.id}
        isAdmin={profile.role === "admin"}
      />

      <NotesPanel
        ownerType="ghost_sheet"
        ownerId={sheet.id}
        notes={notes}
        agentId={profile.id}
        isAdmin={profile.role === "admin"}
      />
    </>
  );
}

export default function GhostSheetDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <PageShell width="detail">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/ghost-sheets">
          <ArrowLeftIcon size={16} />
          Back to ghost sheets
        </Link>
      </Button>

      <Suspense
        fallback={<p className="text-sm text-muted-foreground">Loading…</p>}
      >
        <GhostSheetDetail params={params} />
      </Suspense>
    </PageShell>
  );
}
