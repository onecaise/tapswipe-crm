import { Suspense } from "react";

import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  COMPATIBILITY_COLUMNS,
  PRODUCT_COLUMNS,
  type CompatibilityRow,
  type Product,
  groupByCategory,
  priceNumber,
} from "@/lib/products";
import { Callout } from "@/components/callout";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { ProductAdminRow } from "@/components/product-admin-row";
import { ProductCreateForm } from "@/components/product-create-form";

async function ManageCatalog() {
  // Application-level boundary: non-admins never render this page. The
  // database is the real boundary — the insert and update policies are
  // is_admin() — so a rep who typed this URL would see the page and have every
  // write refused. The guard is so they get a sensible redirect instead of a
  // wall of errors.
  await requireAdmin();
  const supabase = await createClient();

  // Everything, archived included. That is the difference between this page
  // and the rep-facing picker: a rep builds a quote from the live, priced
  // rows, an admin reads the real state of the table.
  const { data, error } = await supabase
    .from("products")
    .select(PRODUCT_COLUMNS)
    .order("archived_at", { ascending: true, nullsFirst: true })
    .order("category", { ascending: true })
    .order("name", { ascending: true });

  if (error) {
    return (
      <p className="text-sm text-destructive">
        Could not load the catalog: {error.message}
      </p>
    );
  }

  const products = (data ?? []) as Product[];
  const unpriced = products.filter(
    (product) =>
      product.archived_at === null && priceNumber(product.list_price) === null,
  ).length;
  const groups = groupByCategory(products);

  // Every compatibility row, read once for the whole page. Per-row reads would
  // be one identical query per add-on.
  const { data: compatRows } = await supabase
    .from("product_compatibility")
    .select(COMPATIBILITY_COLUMNS);

  // Keyed by ADD-ON here, which is the opposite of what the store needs. The
  // store asks "a rep added this terminal, what fits it"; this page asks "this
  // accessory is open, which devices is it ticked against" — so the same table
  // is indexed both ways and compatibilityByDevice() serves the other caller.
  const fitsByAddon = new Map<number, number[]>();
  for (const row of (compatRows ?? []) as CompatibilityRow[]) {
    const list = fitsByAddon.get(row.addon_product_id);
    if (list) list.push(row.device_product_id);
    else fitsByAddon.set(row.addon_product_id, [row.device_product_id]);
  }

  // Live devices only, in catalog order. Linking an add-on to an ARCHIVED
  // device would record a pairing the store can never offer, because an
  // archived device is not in the store to be a parent.
  const devices = products.filter(
    (product) => product.kind === "device" && product.archived_at === null,
  );

  return (
    <>
      <ProductCreateForm />

      {unpriced > 0 && (
        <Callout tone="warning">
          {unpriced === 1
            ? "One live product has no list price, so it cannot be put on a quote. Price it, or archive it."
            : `${unpriced} live products have no list price, so they cannot be put on a quote. Price them, or archive them.`}
        </Callout>
      )}

      <section className="flex flex-col gap-4">
        <h2 className="font-semibold">Catalog</h2>
        {products.length === 0 ? (
          // Deliberately empty until the real pricing sheet arrives. Seeding
          // plausible-looking placeholder hardware would put figures in front
          // of a rep that nobody at this company agreed to.
          <p className="text-sm text-muted-foreground">
            The catalog is empty. Nothing is seeded here on purpose — a quote
            snapshots the price it was built from, so a placeholder figure
            would end up on a document a merchant reads. The form above adds
            the first real one.
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.category} className="flex flex-col gap-2">
              <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
                {group.category}
              </h3>
              <ul className="flex flex-col divide-y rounded-md border">
                {group.products.map((product) => (
                  <ProductAdminRow
                    key={product.id}
                    product={product}
                    devices={devices}
                    fitsDeviceIds={fitsByAddon.get(product.id) ?? []}
                  />
                ))}
              </ul>
            </div>
          ))
        )}
      </section>

      <p className="text-xs text-muted-foreground">
        Products are archived, never deleted: every quote line records the
        product it was built from, and removing one would take that reference
        with it. An archived product disappears from the quote builder and
        stays readable on every quote that already names it. Editing a price
        here does not change any quote that has already been built — the price,
        name and model number are copied onto the quote when it is created.
      </p>
    </>
  );
}

export default function ManageProductsPage() {
  return (
    <PageShell width="list">
      <PageHeader
        title="Product catalog"
        subtitle="The hardware and services a quote is built from. Admin-only to edit; every active rep can read it."
      />

      <Suspense
        fallback={
          <p className="text-sm text-muted-foreground">Loading catalog…</p>
        }
      >
        <ManageCatalog />
      </Suspense>
    </PageShell>
  );
}
