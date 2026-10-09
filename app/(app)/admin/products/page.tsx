import Link from "next/link";
import { Suspense } from "react";

import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  BRAND_COLUMNS,
  type Brand,
  brandHref,
  summarizeBrands,
} from "@/lib/brands";
import type { Product } from "@/lib/products";
import { BrandAddBox } from "@/components/brand-add-box";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";

async function BrandGrid() {
  // Application-level boundary: a rep is redirected rather than shown a page
  // whose every write is refused. The database is the real boundary — every
  // write policy on brands, products and product_compatibility is is_admin().
  await requireAdmin();
  const supabase = await createClient();

  const [brandsResult, productsResult] = await Promise.all([
    supabase.from("brands").select(BRAND_COLUMNS),
    // Only what a box counts. Archived rows included: they still pin the
    // brand, and the box says how many are inactive.
    supabase.from("products").select("brand, archived_at"),
  ]);

  const loadError = brandsResult.error ?? productsResult.error;
  if (loadError) {
    return (
      <p className="text-sm text-destructive">
        Could not load the catalog: {loadError.message}
      </p>
    );
  }

  const summaries = summarizeBrands(
    (brandsResult.data ?? []) as Brand[],
    (productsResult.data ?? []) as Pick<Product, "brand" | "archived_at">[],
  );

  return (
    // auto-fill at a 10rem floor: two boxes across a 375px phone, three or
    // four on a tablet, six on a desktop, with no breakpoint to keep in step.
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3">
      {summaries.map(({ brand, total, inactive }) => (
        <li key={brand?.id ?? "unbranded"} className="min-w-0">
          <Link
            href={brandHref(brand)}
            className="flex h-full min-h-24 min-w-0 flex-col gap-1 rounded-md border bg-card p-4 transition-colors hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="truncate font-semibold">
              {brand?.name ?? "Other"}
            </span>
            <span className="text-sm text-muted-foreground">
              {total} product{total === 1 ? "" : "s"}
            </span>
            {inactive > 0 && (
              <span className="text-xs text-muted-foreground">
                {inactive} inactive
              </span>
            )}
          </Link>
        </li>
      ))}
      <li className="min-w-0">
        <BrandAddBox />
      </li>
    </ul>
  );
}

export default function ManageProductsPage() {
  return (
    <PageShell width="list">
      <PageHeader
        title="Product catalog"
        subtitle="One box per brand. Open one to add, edit or archive its products."
      />
      <Suspense
        fallback={<p className="text-sm text-muted-foreground">Loading…</p>}
      >
        <BrandGrid />
      </Suspense>
    </PageShell>
  );
}
