/**
 * Quotes — shared types and the browser-side rules.
 *
 * The one thing to carry out of this file: **the current version of a quote is
 * the highest `version` in its `quote_group_id`**. There is no is_current
 * flag, so that rule lives in `currentVersion()` below and nowhere else. The
 * database guarantees the rule is well-defined — `unique (quote_group_id,
 * version)` means a group can never hold two rows at the same version — but it
 * does not evaluate the rule for anybody.
 */

import type { StatusIntent } from "@/components/status-badge";

export const QUOTE_STATUSES = [
  "draft",
  "sent",
  "accepted",
  "declined",
  "expired",
] as const;

export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

/**
 * Mirrors the check constraint on quotes.status.
 *
 * Unlike leads.status, this table shipped WITH its vocabulary, so there are no
 * rows predating it holding rep-typed strings — the constraint is ordinary
 * rather than NOT VALID and binds every row. The guard is kept anyway, because
 * `status` arrives from PostgREST typed as `string` and a widened constraint
 * would otherwise surface as a crash on a missing label rather than as a
 * value that renders plainly.
 */
export function isQuoteStatus(value: string | null): value is QuoteStatus {
  return (QUOTE_STATUSES as readonly string[]).includes(value ?? "");
}

export const QUOTE_STATUS_LABELS: Record<QuoteStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  accepted: "Accepted",
  declined: "Declined",
  expired: "Expired",
};

/**
 * The three shared status intents.
 *
 * `declined` and `expired` are GREY, not red, for the reason `lost` is grey in
 * lib/leads.ts: a status badge never wears brand or destructive colour, and a
 * declined quote is an inert record rather than an irreversible action. Only
 * `accepted` is success — a sent quote is in flight, which is the warning
 * (in-progress) intent, matching how leads treats its mid-pipeline values.
 */
export function statusIntent(status: string | null): StatusIntent {
  if (status === "accepted") return "success";
  if (status === "sent") return "warning";
  return "neutral";
}

export type Quote = {
  id: number;
  quote_group_id: string;
  version: number;
  lead_id: number;
  agent_id: string;
  status: string;
  title: string | null;
  notes: string | null;
  created_at: string | null;
};

export const QUOTE_COLUMNS =
  "id, quote_group_id, version, lead_id, agent_id, status, title, notes, created_at";

export type QuoteLineItem = {
  id: number;
  quote_id: number;
  product_id: number;
  quantity: number;
  unit_price: string | number;
  product_name: string;
  product_sku: string | null;
  line_total: string | number;
  sort_order: number;
};

export const QUOTE_LINE_COLUMNS =
  "id, quote_id, product_id, quantity, unit_price, product_name, product_sku, line_total, sort_order";

/** A quote group: every version of one quote, and which of them is current. */
export type QuoteGroup = {
  quoteGroupId: string;
  /** Newest first, so [0] is the current version. */
  versions: Quote[];
  current: Quote;
};

/**
 * numeric(12,2) arrives from PostgREST as a STRING.
 *
 * Same reason as priceNumber() in lib/products.ts: Postgres `numeric` has no
 * lossless JavaScript number, so supabase-js hands it over verbatim. Kept
 * separate from that one rather than imported, because a quote line's figures
 * are `not null` in the schema and a catalog price is not — this returns a
 * number, that one returns `number | null`, and collapsing them would make a
 * missing list price indistinguishable from a zero line.
 */
export function money(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * THE rule: the current version is the highest version in the group.
 *
 * One implementation, called by everything that needs it, because the rule is
 * not enforced anywhere in the database — only the uniqueness that makes it
 * unambiguous is. Spelling `Math.max` inline at two call sites is how a list
 * page and a detail page come to disagree about which version a merchant was
 * shown.
 */
export function currentVersion(versions: Quote[]): Quote {
  return versions.reduce((latest, q) => (q.version > latest.version ? q : latest));
}

/**
 * Groups a flat list of quote rows into one entry per quote_group_id.
 *
 * Groups are ordered by their current version's creation, newest first, so the
 * lead page leads with the most recently touched quote. Versions within a
 * group are newest first for the same reason.
 */
export function groupQuotes(quotes: Quote[]): QuoteGroup[] {
  const byGroup = new Map<string, Quote[]>();
  for (const quote of quotes) {
    const list = byGroup.get(quote.quote_group_id);
    if (list) list.push(quote);
    else byGroup.set(quote.quote_group_id, [quote]);
  }

  return [...byGroup.entries()]
    .map(([quoteGroupId, list]) => {
      const versions = [...list].sort((a, b) => b.version - a.version);
      return { quoteGroupId, versions, current: currentVersion(versions) };
    })
    .sort((a, b) => {
      const byDate = (b.current.created_at ?? "").localeCompare(
        a.current.created_at ?? "",
      );
      // created_at defaults to now() and two versions written in the same
      // millisecond would tie, so the version number breaks it rather than
      // leaving the order down to whatever the sort happened to do.
      return byDate !== 0 ? byDate : b.current.version - a.current.version;
    });
}

/** A line as the builder holds it, before it is written. */
export type DraftLine = {
  productId: number;
  quantity: number;
};

/**
 * The total of a set of saved line items.
 *
 * Reads `line_total`, the STORED GENERATED column, rather than recomputing
 * quantity × unit_price — the database already worked it out, and a second
 * implementation here is a figure that can disagree with the one on the row.
 */
export function quoteTotal(lines: QuoteLineItem[]): number {
  return lines.reduce((sum, line) => sum + money(line.line_total), 0);
}

/**
 * The running total of a draft, before anything is written.
 *
 * This one DOES multiply, because there is no stored column yet — the draft
 * exists only in browser state. It takes the price from the catalog row the
 * rep picked, which is the same figure create_quote_version() will read
 * server-side, so the preview and the saved quote agree. They can still differ
 * if an admin reprices between the preview and the save; the server's copy is
 * the real one, and the builder re-reads after a save rather than assuming.
 */
export function draftTotal(
  lines: DraftLine[],
  priceOf: (productId: number) => number | null,
): number {
  return lines.reduce((sum, line) => {
    const price = priceOf(line.productId);
    return price === null ? sum : sum + price * line.quantity;
  }, 0);
}

/**
 * Why a draft cannot be saved, or null if it can.
 *
 * Mirrors create_quote_version()'s own refusals rather than replacing them —
 * the RPC is the boundary and raises inside the transaction that would write
 * the quote. What this buys is the Save button explaining itself instead of
 * the rep clicking it and reading a Postgres exception.
 */
export function draftProblem(lines: DraftLine[]): string | null {
  if (lines.length === 0) {
    return "Add at least one line item.";
  }
  if (lines.some((line) => !Number.isInteger(line.quantity) || line.quantity < 1)) {
    return "Every line needs a whole quantity of at least 1.";
  }
  return null;
}

/**
 * The payload shape create_quote_version() expects in `line_items_input`.
 *
 * product_id and quantity, and deliberately nothing else: the price, name and
 * sku are read off the catalog server-side, inside the transaction that writes
 * the quote. Sending a unit_price from here would be the documents.file_key
 * shape again — a figure no policy reads, on a document handed to a merchant.
 */
export function lineItemsPayload(
  lines: DraftLine[],
): { product_id: number; quantity: number }[] {
  return lines.map((line) => ({
    product_id: line.productId,
    quantity: line.quantity,
  }));
}
