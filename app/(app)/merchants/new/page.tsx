import Link from "next/link";
import { Suspense } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { requireAdmin } from "@/lib/auth";
import { loadOwnerOptions } from "@/lib/merchant-owners";
import { createClient } from "@/lib/supabase/server";
import { PageShell } from "@/components/page-shell";
import { MerchantForm } from "@/components/merchant-form";
import { Button } from "@/components/ui/button";

async function NewMerchant() {
  // Merchants are admin-only to create (20261021120000); a rep's come from
  // approve_pre_app(). RLS refuses a rep's insert anyway.
  const profile = await requireAdmin();
  const owners = await loadOwnerOptions(await createClient(), profile.id);

  return <MerchantForm owners={owners} />;
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
