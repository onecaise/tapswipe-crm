/**
 * Brands — the boxes /admin/products is organised by.
 *
 * `brands` is the fourth client-readable table with no agent_id: every active
 * rep reads it, only an admin writes it, and RLS is the whole of that. Nothing
 * here is an access rule. products.brand is a foreign key to brands(name) with
 * ON UPDATE CASCADE, so a rename here is a rename everywhere, and ON DELETE
 * RESTRICT, so the database refuses to delete a brand any product still names.
 */

import type { Product } from "@/lib/products";

export type Brand = {
  id: number;
  name: string;
};

export const BRAND_COLUMNS = "id, name";

/**
 * The path segment for products with no brand.
 *
 * A static route beside /admin/products/[brandId] rather than a magic id:
 * unbranded products are not a row in `brands`, and pretending otherwise would
 * put a fake brand in front of every reader of the id.
 */
export const UNBRANDED_SEGMENT = "unbranded";

export function brandHref(brand: Brand | null): string {
  return brand === null
    ? `/admin/products/${UNBRANDED_SEGMENT}`
    : `/admin/products/${brand.id}`;
}

/**
 * What a brand box shows: how many products, and how many of those are
 * archived. Archived products count toward the total because they still pin
 * the brand — the FK refuses to delete a brand any of them names.
 */
export type BrandSummary = {
  brand: Brand | null;
  total: number;
  inactive: number;
};

/**
 * One summary per brand, in name order, with the unbranded bucket last and
 * ONLY when it holds something.
 *
 * Every brand gets a box even with zero products — adding one ahead of its
 * first product is why the table exists. The unbranded bucket is not a brand,
 * so an empty one is not shown: a permanent "Other (0)" box is a box that
 * means nothing.
 */
export function summarizeBrands(
  brands: readonly Brand[],
  products: readonly Pick<Product, "brand" | "archived_at">[],
): BrandSummary[] {
  const counts = new Map<string | null, { total: number; inactive: number }>();
  for (const product of products) {
    const key = product.brand ?? null;
    const entry = counts.get(key) ?? { total: 0, inactive: 0 };
    entry.total += 1;
    if (product.archived_at !== null) entry.inactive += 1;
    counts.set(key, entry);
  }

  const named = [...brands]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((brand) => ({
      brand,
      ...(counts.get(brand.name) ?? { total: 0, inactive: 0 }),
    }));

  const unbranded = counts.get(null);
  return unbranded ? [...named, { brand: null, ...unbranded }] : named;
}

/**
 * A brand's products in page order: devices first, then add-ons, each by name.
 *
 * Kind before name because an add-on is configured against a device, so the
 * devices are what an admin reads first. Archived rows are interleaved rather
 * than pushed to the bottom — the row's own badge says it is archived, and
 * moving a row when it is archived makes the Restore button jump away from
 * under the cursor that just clicked Archive.
 */
export function sortBrandProducts<T extends Pick<Product, "kind" | "name">>(
  products: readonly T[],
): T[] {
  const rank = (kind: string) => (kind === "device" ? 0 : 1);
  return [...products].sort(
    (a, b) => rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name),
  );
}

/**
 * Normalises a typed brand name to what brands_name_trimmed accepts.
 *
 * Returns null for blank. The CHECK is the boundary; this is the courtesy that
 * turns a constraint violation into a disabled button.
 */
export function normalizeBrandName(input: string): string | null {
  const trimmed = input.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * A readable sentence for a write the brands table refused, or the raw message.
 *
 * The two refusals an admin can actually hit from these pages are a name
 * already taken (exact, or by case through idx_brands_name_lower) and a delete
 * blocked by products_brand_fkey. Both arrive as Postgres errors that name a
 * constraint, which is accurate and unreadable.
 */
export function brandWriteError(message: string): string {
  if (/idx_brands_name_lower|brands_name_key|duplicate key/i.test(message)) {
    return "A brand with that name already exists.";
  }
  if (/products_brand_fkey/i.test(message)) {
    return "This brand still has products, so it cannot be deleted. Move or rename them first.";
  }
  if (/brands_name_trimmed/i.test(message)) {
    return "A brand needs a name.";
  }
  return message;
}

/**
 * Whether a device matches the add-on picker's search box: name or model.
 */
export function matchesDeviceSearch(
  device: Pick<Product, "name" | "sku">,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return [device.name, device.sku].some(
    (field) => field !== null && field.toLowerCase().includes(needle),
  );
}

/**
 * The link writes that turn `current` into `wanted`, as two id lists.
 *
 * product_compatibility rows are facts with nothing to update, so a change is
 * a set of deletes and a set of inserts — never a wholesale replace, which
 * would delete and re-insert links that did not change and leave a window
 * where the add-on fits nothing.
 */
export function diffLinks(
  current: readonly number[],
  wanted: readonly number[],
): { add: number[]; remove: number[] } {
  const have = new Set(current);
  const want = new Set(wanted);
  return {
    add: [...want].filter((id) => !have.has(id)),
    remove: [...have].filter((id) => !want.has(id)),
  };
}
