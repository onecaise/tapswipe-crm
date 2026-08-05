import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { type GhostSheet } from "@/lib/ghost-sheets";
import { GhostSheetForm } from "@/components/ghost-sheet-form";
import { Button } from "@/components/ui/button";

async function EditGhostSheet({
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

  if (error || !data) {
    notFound();
  }

  const sheet = data as GhostSheet;

  return (
    <>
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href={`/ghost-sheets/${sheet.id}`}>
          <ArrowLeftIcon size={16} />
          Back to ghost sheet
        </Link>
      </Button>
      <GhostSheetForm sheet={sheet} agentId={profile.id} />
    </>
  );
}

export default function EditGhostSheetPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <div className="flex-1 w-full flex flex-col gap-6 p-6 md:p-10 max-w-3xl mx-auto">
      <Suspense
        fallback={<p className="text-sm text-muted-foreground">Loading…</p>}
      >
        <EditGhostSheet params={params} />
      </Suspense>
    </div>
  );
}
