import Link from "next/link";
import { Suspense } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { PageShell } from "@/components/page-shell";
import { GhostSheetForm } from "@/components/ghost-sheet-form";
import { Button } from "@/components/ui/button";

async function NewGhostSheet() {
  const profile = await requireUser();

  return <GhostSheetForm agentId={profile.id} />;
}

export default function NewGhostSheetPage() {
  return (
    <PageShell width="form">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/ghost-sheets">
          <ArrowLeftIcon size={16} />
          Back to ghost sheets
        </Link>
      </Button>

      <Suspense
        fallback={<p className="text-sm text-muted-foreground">Loading…</p>}
      >
        <NewGhostSheet />
      </Suspense>
    </PageShell>
  );
}
