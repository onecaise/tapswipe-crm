/**
 * The product catalog — shared types and the browser-side rules.
 *
 * `products` is the second client-readable table with no agent_id (after
 * marketing_materials): company reference data every active rep reads and only
 * an admin writes. Nothing here is an access rule — RLS is the whole of that —
 * so these are display and input-normalisation helpers.
 */

import type { StatusIntent } from "@/components/status-badge";

export type Product = {
  id: number;
  name: string;
  sku: string | null;
  category: string;
  list_price: string | number | null;
  description: string | null;
  specs: Record<string, unknown>;
  archived_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export const PRODUCT_COLUMNS =
  "id, name, sku, category, list_price, description, specs, archived_at, created_at, updated_at";

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
