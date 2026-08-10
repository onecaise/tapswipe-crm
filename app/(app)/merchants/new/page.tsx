import Link from "next/link";
import { Suspense } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { MerchantForm } from "@/components/merchant-form";
import { Button } from "@/components/ui/button";

async function NewMerchant() {
  const profile = await requireUser();

  return <MerchantForm agentId={profile.id} />;
}

export default function NewMerchantPage() {
  return (
    <div className="flex-1 w-full flex flex-col gap-6 max-w-3xl mx-auto">
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
    </div>
  );
}
