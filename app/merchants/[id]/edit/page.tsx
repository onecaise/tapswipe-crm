import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { type Merchant } from "@/lib/merchants";
import { MerchantForm } from "@/components/merchant-form";
import { Button } from "@/components/ui/button";

async function EditMerchant({
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

  // Same reasoning as the detail page: nonexistent and not-yours are both 404,
  // so the edit route can't be used to probe which merchant ids exist.
  if (error || !data) {
    notFound();
  }

  const merchant = data as Merchant;

  return (
    <>
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href={`/merchants/${merchant.id}`}>
          <ArrowLeftIcon size={16} />
          Back to merchant
        </Link>
      </Button>
      <MerchantForm merchant={merchant} agentId={profile.id} />
    </>
  );
}

export default function EditMerchantPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // params stays unawaited here — awaiting it outside Suspense is what
  // cacheComponents rejects at build time. The back link lives inside the async
  // child because it needs the id.
  return (
    <div className="flex-1 w-full flex flex-col gap-6 p-6 md:p-10 max-w-3xl mx-auto">
      <Suspense
        fallback={<p className="text-sm text-muted-foreground">Loading…</p>}
      >
        <EditMerchant params={params} />
      </Suspense>
    </div>
  );
}
