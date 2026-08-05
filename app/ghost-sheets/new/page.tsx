import Link from "next/link";
import { Suspense } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { GhostSheetForm } from "@/components/ghost-sheet-form";
import { Button } from "@/components/ui/button";

async function NewGhostSheet() {
  const profile = await requireUser();

  return <GhostSheetForm agentId={profile.id} />;
}

export default function NewGhostSheetPage() {
  return (
    <div className="flex-1 w-full flex flex-col gap-6 p-6 md:p-10 max-w-3xl mx-auto">
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
    </div>
  );
}
