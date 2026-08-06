import Link from "next/link";
import { Suspense } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { PreAppCreateForm } from "@/components/pre-app-create-form";
import { Button } from "@/components/ui/button";

async function NewPreApp() {
  const profile = await requireUser();
  return <PreAppCreateForm agentId={profile.id} />;
}

export default function NewPreAppPage() {
  return (
    <div className="flex-1 w-full flex flex-col gap-6 p-6 md:p-10 max-w-3xl mx-auto">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/pre-apps">
          <ArrowLeftIcon size={16} />
          Back to pre-apps
        </Link>
      </Button>

      <Suspense
        fallback={<p className="text-sm text-muted-foreground">Loading…</p>}
      >
        <NewPreApp />
      </Suspense>
    </div>
  );
}
