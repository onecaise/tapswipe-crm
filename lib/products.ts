/**
 * The product catalog — shared types and the browser-side rules.
 *
 * `products` is the second client-readable table with no agent_id (after
 * marketing_materials): company reference data every active rep reads and only
 * an admin writes. Nothing here is an access rule — RLS is the whole of that —
 * so these are display and input-normalisation helpers.
 */

import type { StatusIntent } from "@/components/status-badge";

/**
 * Whether a product stands on its own in a cart, or hangs off one that does.
 *
 * A closed vocabulary mirroring the CHECK, unlike `category` and `brand` —
 * and the difference is who reads it. Those two are labels a person reads;
 * this is read by code (the compatibility trigger, the store's device list,
 * the printed proposal's grouping), so a third value would not be a new label
 * but a row all three silently skip.
 */
export const PRODUCT_KINDS = ["device", "addon"] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number];

export const PRODUCT_KIND_LABELS: Record<ProductKind, string> = {
  device: "Device",
  addon: "Add-on",
};

/** One-off hardware, or a recurring charge. Mirrors the CHECK. */
export const PRODUCT_BILLINGS = ["one_time", "monthly"] as const;
export type ProductBilling = (typeof PRODUCT_BILLINGS)[number];

export const PRODUCT_BILLING_LABELS: Record<ProductBilling, string> = {
  one_time: "One-time",
  monthly: "Monthly",
};

/**
 * Both guards exist for the reason isQuoteStatus() does.
 *
 * The columns are `not null` with a CHECK, so every row really does hold one
 * of the two — but PostgREST types them as `string`, and a widened vocabulary
 * would otherwise surface as a crash on a missing label rather than as a value
 * that renders plainly. Neither is an access rule; both are display guards.
 */
export function isProductKind(value: string | null): value is ProductKind {
  return (PRODUCT_KINDS as readonly string[]).includes(value ?? "");
}

export function isProductBilling(value: string | null): value is ProductBilling {
  return (PRODUCT_BILLINGS as readonly string[]).includes(value ?? "");
}

export type Product = {
  id: number;
  name: string;
  sku: string | null;
  category: string;
  /**
   * The manufacturer, and the store's primary browse axis.
   *
   * Nullable, and the store buckets the nulls under one explicit heading.
   * The catalog legitimately holds things no manufacturer makes, so NOT NULL
   * would have forced an admin to type a value that then appears in a rep's
   * brand list as if it were a vendor.
   */
  brand: string | null;
  kind: string;
  billing: string;
  list_price: string | number | null;
  description: string | null;
  specs: Record<string, unknown>;
  archived_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export const PRODUCT_COLUMNS =
  "id, name, sku, category, brand, kind, billing, list_price, description, specs, archived_at, created_at, updated_at";

/**
 * Which add-ons fit which devices, as the store needs to ask it.
 *
 * Keyed by DEVICE, because the only question anything asks is "a rep just
 * added this terminal — what fits it". The row is stored
 * (addon_product_id, device_product_id) and the table's extra index leads
 * with the device for exactly this lookup.
 */
export type CompatibilityRow = {
  addon_product_id: number;
  device_product_id: number;
};

export const COMPATIBILITY_COLUMNS = "addon_product_id, device_product_id";

/** device id -> the add-on ids recorded as fitting it. */
export function compatibilityByDevice(
  rows: readonly CompatibilityRow[],
): Map<number, number[]> {
  const byDevice = new Map<number, number[]>();
  for (const row of rows) {
    const list = byDevice.get(row.device_product_id);
    if (list) list.push(row.addon_product_id);
    else byDevice.set(row.device_product_id, [row.addon_product_id]);
  }
  return byDevice;
}

/**
 * Suggested categories, mirroring SUGGESTED_CATEGORIES in
 * lib/marketing-materials.ts and SUGGESTED_DOC_TYPES.
 *
 * `category` is `text not null` with no vocabulary in the schema —
 * deliberately, so a new kind of hardware does not need a migration — so this
 * is a convenience list behind a datalist, not a constraint. The input accepts
 * anything.
 */
export const SUGGESTED_PRODUCT_CATEGORIES = [
  "Countertop terminals",
  "Mobile / wireless",
  "POS systems",
  "PIN pads",
  "Accessories",
  "Gateway & software",
  "Services",
] as const;

/**
 * numeric(12,2) arrives from PostgREST as a STRING, not a number.
 *
 * js-bigint-safe serialisation is why: Postgres `numeric` has no lossless
 * JavaScript number, so supabase-js hands it over verbatim. Every money read
 * in this file goes through here rather than relying on `Number(x)` scattered
 * at call sites — the same reason lib/payouts.ts parses its figures in one
 * place. Null stays null, because a missing list price means "not priced yet"
 * and must never collapse to 0.
 */
export function priceNumber(value: string | number | null): number | null {
  if (value === null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** True when a product can go on a quote: live, and priced. */
export function isQuotable(product: Product): boolean {
  return product.archived_at === null && priceNumber(product.list_price) !== null;
}

/**
 * Why a product cannot go on a quote, or null if it can.
 *
 * A courtesy that mirrors create_quote_version()'s three refusals rather than
 * replacing them — the RPC is the boundary, and it raises on exactly these
 * cases inside the same transaction that would write the quote. What this buys
 * is the picker explaining itself instead of silently omitting rows an admin
 * can see in /admin/products and cannot find here.
 */
export function unquotableReason(product: Product): string | null {
  if (product.archived_at !== null) return "Archived";
  if (priceNumber(product.list_price) === null) return "No list price yet";
  return null;
}

/**
 * Normalises a SKU input to what the column should hold.
 *
 * '' must never be stored: idx_products_sku is partial on `sku is not null`,
 * so the empty string is a VALUE that index enforces, and two products cleared
 * that way would collide on a uniqueness rule neither admin intended to touch.
 * The same rule set_agent_number() applies in SQL, here in the one place the
 * browser writes this column.
 */
export function normalizeSku(input: string): string | null {
  const trimmed = input.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Normalises a brand input to what the column should hold.
 *
 * Same shape as normalizeSku and a different reason. A blank sku collides with
 * the next blank sku on idx_products_sku, so it fails loudly on the second
 * one; `brand` has no uniqueness to trip over, so '' would simply render as an
 * empty heading in the store's browse list and nothing would object. That is
 * why this column — unlike sku — also carries a CHECK
 * (`products_brand_not_blank`): this function is the courtesy, the constraint
 * is the boundary.
 */
export function normalizeBrand(input: string): string | null {
  const trimmed = input.trim();
  return trimmed === "" ? null : trimmed;
}

/** The brand heading for products that have none. Shown, never stored. */
export const UNBRANDED_LABEL = "Other";

/**
 * The brands present in a set of products, in display order, with the
 * unbranded bucket last.
 *
 * Last rather than alphabetical: "Other" is a residue, and sorting it between
 * two real manufacturers reads as a third manufacturer. Returns null for the
 * bucket rather than the label, so a caller filters on the column's real value
 * and the label stays a display concern.
 */
export function brandOptions(products: readonly Product[]): (string | null)[] {
  const named = new Set<string>();
  let hasUnbranded = false;
  for (const product of products) {
    if (product.brand === null || product.brand === "") hasUnbranded = true;
    else named.add(product.brand);
  }
  const sorted: (string | null)[] = [...named].sort((a, b) =>
    a.localeCompare(b),
  );
  if (hasUnbranded) sorted.push(null);
  return sorted;
}

/** The categories present in a set of products — the store's "type" filter. */
export function categoryOptions(products: readonly Product[]): string[] {
  return [...new Set(products.map((p) => p.category))].sort((a, b) =>
    a.localeCompare(b),
  );
}

/**
 * Whether a product matches a free-text search over the fields a rep would
 * type: name, sku and brand.
 *
 * Not `category` or `description`. Category is already a filter beside the
 * box, so including it means typing "terminal" silently widens to every row in
 * that folder; description is prose, and matching it makes a search for "mini"
 * hit anything whose blurb says "minimal setup".
 */
export function matchesProductSearch(product: Product, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return [product.name, product.sku, product.brand].some(
    (field) => field !== null && field.toLowerCase().includes(needle),
  );
}

/**
 * Parses a typed price into what the column should hold, or reports why not.
 *
 * Returns `{ value }` on success — where `null` is the legitimate "not priced
 * yet" — and `{ error }` otherwise. Modelled on parseFigureInput() in
 * lib/payouts.ts, including the reason it is not just `Number(x)`: an empty
 * box and a zero are different answers, and `Number("")` is 0.
 */
export function parsePriceInput(
  input: string,
): { value: number | null; error?: undefined } | { value?: undefined; error: string } {
  const trimmed = input.trim();
  if (trimmed === "") return { value: null };

  // Tolerate what an admin copying from a price sheet actually types.
  const cleaned = trimmed.replace(/[$,\s]/g, "");
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return { error: "That is not a number." };
  if (parsed < 0) {
    return { error: "A list price cannot be negative." };
  }
  if (Math.round(parsed * 100) / 100 !== parsed) {
    return { error: "A list price can have at most two decimal places." };
  }
  if (parsed >= 10 ** 10) {
    return { error: "That price is too large for the column." };
  }
  return { value: parsed };
}

/**
 * Parses the specs box into the object the column must hold.
 *
 * The CHECK is `jsonb_typeof(specs) = 'object'`, so `4`, `null` and `[1,2]`
 * are all valid JSON and all rejected by the database. Catching that here
 * turns a constraint violation into a sentence saying what shape is wanted.
 */
export function parseSpecsInput(
  input: string,
): { value: Record<string, unknown>; error?: undefined } | { value?: undefined; error: string } {
  const trimmed = input.trim();
  if (trimmed === "") return { value: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { error: "Specs must be valid JSON." };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      error: 'Specs must be a JSON object, like {"connectivity": "wifi"}.',
    };
  }
  return { value: parsed as Record<string, unknown> };
}

/** Pretty-prints specs for the edit box. `{}` renders empty, not as "{}". */
export function formatSpecs(specs: Record<string, unknown>): string {
  if (specs === null || Object.keys(specs).length === 0) return "";
  return JSON.stringify(specs, null, 2);
}

/**
 * Archived or live — the only two states, so the only two intents.
 *
 * Neutral for archived rather than destructive: archiving is reversible and
 * takes nothing away, and destructive red is reserved for the irreversible.
 * There is nothing irreversible on this table by design.
 */
export function productIntent(product: Product): StatusIntent {
  return product.archived_at === null ? "success" : "neutral";
}

/**
 * Groups products into categories, in display order.
 *
 * Mirrors groupByCategory() in lib/marketing-materials.ts: categories sorted
 * alphabetically, products by name within each, so the catalog has a stable
 * order rather than whatever the id sequence produced.
 */
export function groupByCategory(
  products: Product[],
): { category: string; products: Product[] }[] {
  const byCategory = new Map<string, Product[]>();
  for (const product of products) {
    const list = byCategory.get(product.category);
    if (list) list.push(product);
    else byCategory.set(product.category, [product]);
  }

  return [...byCategory.entries()]
    .map(([category, list]) => ({
      category,
      products: [...list].sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.category.localeCompare(b.category));
}
