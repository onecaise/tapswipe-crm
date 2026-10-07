import { createClient } from "@/lib/supabase/server";
import {
  COMPATIBILITY_COLUMNS,
  PRODUCT_COLUMNS,
  type CompatibilityRow,
  type Product,
  compatibilityByDevice,
  isQuotable,
} from "@/lib/products";
import {
  QUOTE_COLUMNS,
  QUOTE_LINE_COLUMNS,
  type Quote,
  type QuoteLineItem,
  type QuoteOwnerType,
} from "@/lib/quotes";

/**
 * Everything the proposal panel needs for one lead or one merchant.
 *
 * ONE loader for both owner kinds, called by the lead page and the merchant
 * page. The reads are identical apart from which column is filtered, so two
 * copies would be forty duplicated lines whose only difference is a string —
 * and the catalog half (devices, add-ons, compatibility, the quotable filter)
 * has nothing to do with the owner at all.
 *
 * ## Every read is the caller's own, and five policies decide the answer
 *
 *   quotes               own-or-admin
 *   quote_line_items     the same, reached through an `exists` on the parent
 *   products             is_active_agent() or is_admin() — company reference
 *   product_compatibility the same
 *
 * No service-role client and no definer RPC. The owner column is filtered in
 * the query because the PAGE is about one record — that is addressing, not a
 * policy copy: RLS would happily return this rep's quotes on their other
 * records, and the page asked for one.
 *
 * ## What hides an archived product is this file, not a policy
 *
 * `isQuotable` (live, and priced) is applied here rather than in RLS, and the
 * schema doc carries the three reasons at length: an admin must still see
 * everything on /admin/products, archiving is a lifecycle state rather than an
 * access boundary, and a quote outlives the product on it. The database still
 * refuses an archived or unpriced product twice over — in
 * `create_quote_version()` by name, and in `snapshot_quote_line_item()` at a
 * layer no caller can skip — so this filter is a courtesy, not the boundary.
 */
export type QuoteContext = {
  quotes: Quote[];
  linesByQuote: Record<number, QuoteLineItem[]>;
  /** Quotable devices, which is what the store browses. */
  devices: Product[];
  /** Quotable add-ons, offered only under a device they fit. */
  addons: Product[];
  addonsByDevice: Map<number, number[]>;
};

export async function loadQuoteContext(
  ownerType: QuoteOwnerType,
  ownerId: number,
): Promise<QuoteContext> {
  const supabase = await createClient();

  // EVERY version of every proposal, not just the current one, and that is the
  // point of the append-only design rather than an over-fetch: the history
  // view renders superseded versions in full, with their own snapshotted
  // prices. "Which version is current" is then decided in one place —
  // groupQuotes(), which calls currentVersion() — because the database stores
  // no is_current flag, only the uniqueness that makes "highest" unambiguous.
  const ownerColumn = ownerType === "lead" ? "lead_id" : "merchant_id";
  const [{ data: quoteRows }, { data: productRows }, { data: compatRows }] =
    await Promise.all([
      supabase
        .from("quotes")
        .select(QUOTE_COLUMNS)
        .eq(ownerColumn, ownerId)
        .order("created_at", { ascending: false })
        .order("version", { ascending: false }),

      supabase
        .from("products")
        .select(PRODUCT_COLUMNS)
        .is("archived_at", null)
        .order("brand", { ascending: true, nullsFirst: false })
        .order("name", { ascending: true }),

      supabase.from("product_compatibility").select(COMPATIBILITY_COLUMNS),
    ]);

  const quotes = (quoteRows ?? []) as Quote[];

  // Sequential rather than inside the Promise.all above: the ids come from the
  // query that just ran. Skipped entirely when there are none — `.in()` with
  // an empty list is a request that can only return nothing.
  const quoteIds = quotes.map((quote) => quote.id);
  const { data: lineRows } = quoteIds.length
    ? await supabase
        .from("quote_line_items")
        .select(QUOTE_LINE_COLUMNS)
        .in("quote_id", quoteIds)
        .order("sort_order", { ascending: true })
        .order("id", { ascending: true })
    : { data: [] };

  const linesByQuote: Record<number, QuoteLineItem[]> = {};
  for (const line of (lineRows ?? []) as QuoteLineItem[]) {
    (linesByQuote[line.quote_id] ??= []).push(line);
  }

  const quotable = ((productRows ?? []) as Product[]).filter(isQuotable);

  return {
    quotes,
    linesByQuote,
    // Split by kind here rather than in the component, so the store receives
    // two lists it can trust instead of one it has to partition. A value
    // outside the vocabulary lands in `devices` — the same direction
    // groupQuoteLines() takes: a widened `kind` should read as a standalone
    // item rather than disappear into an add-on list under a device nobody
    // linked it to.
    devices: quotable.filter((product) => product.kind !== "addon"),
    addons: quotable.filter((product) => product.kind === "addon"),
    addonsByDevice: compatibilityByDevice(
      (compatRows ?? []) as CompatibilityRow[],
    ),
  };
}
