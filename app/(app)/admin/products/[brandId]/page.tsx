import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { BRAND_COLUMNS, type Brand } from "@/lib/brands";
import { BrandCatalog } from "@/components/brand-catalog";
import { PageShell } from "@/components/page-shell";
import { Button } from "@/components/ui/button";

async function BrandDetail({ params }: { params: Promise<{ brandId: string }> }) {
  const { brandId } = await params;
  await requireAdmin();

  const id = Number(brandId);
  if (!Number.isInteger(id)) notFound();

  const supabase = await createClient();
  const { data } = await supabase
    .from("brands")
    .select(BRAND_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (!data) notFound();

  return <BrandCatalog brand={data as Brand} />;
}

export default function BrandPage({
  params,
}: {
  params: Promise<{ brandId: string }>;
}) {
  // params passed down unawaited: awaiting here would put dynamic data
  // outside the Suspense boundary, which cacheComponents rejects.
  return (
    <PageShell width="list">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/admin/products">
          <ArrowLeftIcon size={16} />
          All brands
        </Link>
      </Button>
      <Suspense
        fallback={<p className="text-sm text-muted-foreground">Loading…</p>}
      >
        <BrandDetail params={params} />
      </Suspense>
    </PageShell>
  );
}
