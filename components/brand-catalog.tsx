import { createClient } from "@/lib/supabase/server";
import { BRAND_COLUMNS, type Brand, sortBrandProducts } from "@/lib/brands";
import {
  COMPATIBILITY_COLUMNS,
  PRODUCT_COLUMNS,
  SUGGESTED_PRODUCT_CATEGORIES,
  type CompatibilityRow,
  type Product,
  categoryOptions,
} from "@/lib/products";
import { BrandProducts } from "@/components/brand-products";
import { BrandSettings } from "@/components/brand-settings";
import { PageHeader } from "@/components/page-header";

/**
 * One brand's page, or the unbranded bucket's (`brand === null`).
 *
 * Server-rendered body shared by /admin/products/[brandId] and
 * /admin/products/unbranded. The caller has already run requireAdmin() and
 * resolved the brand under RLS.
 *
 * Reads the WHOLE catalog once rather than only this brand's rows: the add-on
 * picker shows a chip for every device an add-on is linked to, including one
 * from another brand (a product moved since it was linked) or one since
 * archived, and those names are not in this brand's slice. It is a few dozen
 * rows, read once.
 */
export async function BrandCatalog({ brand }: { brand: Brand | null }) {
  const supabase = await createClient();

  const [productsResult, brandsResult, compatResult] = await Promise.all([
    supabase.from("products").select(PRODUCT_COLUMNS),
    supabase.from("brands").select(BRAND_COLUMNS).order("name"),
    supabase.from("product_compatibility").select(COMPATIBILITY_COLUMNS),
  ]);

  const loadError =
    productsResult.error ?? brandsResult.error ?? compatResult.error;
  if (loadError) {
    return (
      <p className="text-sm text-destructive">
        Could not load the catalog: {loadError.message}
      </p>
    );
  }

  const all = (productsResult.data ?? []) as Product[];
  const brandName = brand?.name ?? null;
  const mine = sortBrandProducts(
    all.filter((product) => (product.brand ?? null) === brandName),
  );

  // Keyed by ADD-ON: this page asks "which devices does this accessory fit".
  // The store asks the opposite and uses compatibilityByDevice().
  const fitsByAddon: Record<number, number[]> = {};
  for (const row of (compatResult.data ?? []) as CompatibilityRow[]) {
    (fitsByAddon[row.addon_product_id] ??= []).push(row.device_product_id);
  }

  // What an add-on here may be linked to: THIS brand's LIVE devices. Linking
  // to an archived device records a pairing the store can never offer.
  const deviceOptions = mine
    .filter((p) => p.kind === "device" && p.archived_at === null)
    .map(({ id, name, sku }) => ({ id, name, sku }));

  const deviceNames: Record<number, string> = {};
  for (const product of all) deviceNames[product.id] = product.name;

  const categorySuggestions = [
    ...new Set([...SUGGESTED_PRODUCT_CATEGORIES, ...categoryOptions(all)]),
  ].sort((a, b) => a.localeCompare(b));

  const inactive = mine.filter((p) => p.archived_at !== null).length;
  const devices = mine.filter((p) => p.kind === "device").length;

  return (
    <>
      <PageHeader
        title={brand?.name ?? "Other (no brand)"}
        subtitle={
          mine.length === 0
            ? "No products yet."
            : `${devices} device${devices === 1 ? "" : "s"}, ` +
              `${mine.length - devices} add-on${mine.length - devices === 1 ? "" : "s"}` +
              (inactive > 0 ? ` · ${inactive} inactive` : "")
        }
      >
        {brand && (
          <div className="pt-2">
            <BrandSettings brand={brand} productCount={mine.length} />
          </div>
        )}
      </PageHeader>

      <BrandProducts
        brandName={brandName}
        products={mine}
        fitsByAddon={fitsByAddon}
        brands={(brandsResult.data ?? []) as Brand[]}
        categorySuggestions={categorySuggestions}
        deviceOptions={deviceOptions}
        deviceNames={deviceNames}
      />

      <p className="text-xs text-muted-foreground">
        Products are archived, never deleted: a quote line records the product
        it was built from. Editing a price here does not change any quote
        already built — the price, name and model are copied onto the quote
        when it is created.
      </p>
    </>
  );
}
