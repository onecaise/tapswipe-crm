import Link from "next/link";
import { Suspense } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { PageShell } from "@/components/page-shell";
import { MerchantForm } from "@/components/merchant-form";
import { Button } from "@/components/ui/button";

async function NewMerchant() {
  const profile = await requireUser();

  return <MerchantForm agentId={profile.id} />;
}

export default function NewMerchantPage() {
  return (
    <PageShell width="form">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/merchants">
          <ArrowLeftIcon size={16} />
          Back to merchants
        </Link>
      </Button>

      <Suspense
        fallback={<p className="text-sm text-muted-foreground">Loading…</p>}
      >
        <NewMerchant />
      </Suspense>
    </PageShell>
  );
}
