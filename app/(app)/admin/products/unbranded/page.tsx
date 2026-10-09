import Link from "next/link";
import { Suspense } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { requireAdmin } from "@/lib/auth";
import { BrandCatalog } from "@/components/brand-catalog";
import { PageShell } from "@/components/page-shell";
import { Button } from "@/components/ui/button";

/**
 * Products with no brand. products.brand is nullable on purpose (the catalog
 * holds things no manufacturer makes), so they need somewhere to be edited;
 * the grid shows a box for this page only while any exist.
 */
async function Unbranded() {
  await requireAdmin();
  return <BrandCatalog brand={null} />;
}

export default function UnbrandedProductsPage() {
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
        <Unbranded />
      </Suspense>
    </PageShell>
  );
}
