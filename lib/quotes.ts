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
  /** At most one of these two is set — quotes_at_most_one_link. */
  lead_id: number | null;
  merchant_id: number | null;
  /**
   * Who the proposal is for, snapshotted per version: the linked record's
   * name (copied by enforce_quote_version()) or the name the rep typed.
   */
  customer_name: string;
  agent_id: string;
  status: string;
  title: string | null;
  notes: string | null;
  created_at: string | null;
};

export const QUOTE_COLUMNS =
  "id, quote_group_id, version, lead_id, merchant_id, customer_name, agent_id, status, title, notes, created_at";

/**
 * Which kind of record a quote hangs off.
 *
 * Two real foreign keys rather than the polymorphic `owner_type` + `owner_id`
 * that notes, tasks and documents use — see the schema doc. This type exists
 * so the parts of the app that genuinely do not care which one it is (the
 * print document, the builder) can take one value instead of two nullables and
 * a rule about them.
 */
export const QUOTE_OWNER_TYPES = ["lead", "merchant"] as const;
export type QuoteOwnerType = (typeof QUOTE_OWNER_TYPES)[number];

/** Where a quote's print route lives, per owner kind. */
export const QUOTE_OWNER_PATHS: Record<QuoteOwnerType, string> = {
  lead: "/leads",
  merchant: "/merchants",
};

/**
 * The print URL for one version of a quote.
 *
 * One implementation, for the reason currentVersion() is one: the panel, the
 * timeline and the print page's own "current version" link all build this, and
 * three spellings of a path with a search param is how one of them ends up
 * pointing at the wrong version.
 *
 * `quoteId` is optional, and the distinction is the whole of why: the BARE
 * group URL prints whatever is current, which is what a list row wants; an
 * explicit `?quote=` pins one version, which is what a history row wants. A
 * list row pinned to today's row id would keep printing this version after the
 * next revision.
 */
export function quotePrintHref(
  ownerType: QuoteOwnerType,
  ownerId: number,
  quoteGroupId: string,
  quoteId?: number,
): string {
  const base = `${QUOTE_OWNER_PATHS[ownerType]}/${ownerId}/quotes/${quoteGroupId}/print`;
  return quoteId === undefined ? base : `${base}?quote=${quoteId}`;
}

export type QuoteLineItem = {
  id: number;
  quote_id: number;
  product_id: number;
  quantity: number;
  unit_price: string | number;
  product_name: string;
  product_sku: string | null;
  /**
   * Snapshotted, like the price, and read as a plain string on purpose.
   *
   * Typed `string` rather than ProductBilling because the column carries NO
   * CHECK — that is deliberate (see the schema doc): these two are a record of
   * what was true when the quote was sent, so a row holding a value retired
   * from the catalog's vocabulary is correct history. Guarded on read by
   * isLineMonthly() below, the way the lead status badge guards its label.
   */
  product_billing: string;
  product_kind: string;
  line_total: string | number;
  sort_order: number;
};

export const QUOTE_LINE_COLUMNS =
  "id, quote_id, product_id, quantity, unit_price, product_name, product_sku, product_billing, product_kind, line_total, sort_order";

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

/* =========================================================================
 * THE CART.
 *
 * The store's draft is NESTED — a list of devices, each with the add-ons
 * chosen under it — while the database is flat. The nesting is what the UI
 * needs (an add-on only exists in the context of a device it fits) and the
 * flattening is what the schema holds, so the conversion lives here, once,
 * with the ordering rule that makes the two equivalent.
 *
 * THE ORDERING RULE IS LOAD-BEARING, not cosmetic. A saved quote's
 * device/add-on structure is reconstructed from (sort_order, product_kind)
 * and nothing else — see groupQuoteLines() below and the schema doc on
 * quote_line_items.product_kind. The alternative was joining
 * product_compatibility live at print time, which would mean a saved quote
 * re-grouping itself when an admin unlinks an accessory: the one thing the
 * append-only design exists to prevent. So `cartToPayload` MUST emit device,
 * then that device's add-ons, then the next device, and create_quote_version()
 * writes sort_order from the array's own order to preserve it.
 * ====================================================================== */

/** One device in the cart, with the add-ons chosen under it. */
export type CartDevice = {
  productId: number;
  quantity: number;
  addons: DraftLine[];
};

/**
 * Flattens the cart into create_quote_version()'s `line_items_input`.
 *
 * product_id and quantity, and deliberately nothing else: the price, name,
 * sku, billing and kind are read off the catalog server-side, inside the
 * transaction that writes the quote, and re-derived again by
 * snapshot_quote_line_item(). Sending a unit_price from here would be the
 * documents.file_key shape again — a figure no policy reads, on a document
 * handed to a merchant.
 *
 * The ORDER of the returned array is the device/add-on grouping. See the
 * block comment above.
 */
export function cartToPayload(
  cart: readonly CartDevice[],
): { product_id: number; quantity: number }[] {
  const payload: { product_id: number; quantity: number }[] = [];
  for (const device of cart) {
    payload.push({ product_id: device.productId, quantity: device.quantity });
    for (const addon of device.addons) {
      payload.push({ product_id: addon.productId, quantity: addon.quantity });
    }
  }
  return payload;
}

/** Every line in the cart, flat, device-then-add-ons. */
export function cartLines(cart: readonly CartDevice[]): DraftLine[] {
  return cart.flatMap((device) => [
    { productId: device.productId, quantity: device.quantity },
    ...device.addons,
  ]);
}

/**
 * The two totals a hardware proposal carries.
 *
 * Separate rather than one figure, because they are not the same unit: $1,497
 * of terminals and $29 a month are not addable, and a single "total" that
 * summed them would be a number that means nothing and reads as a price. The
 * printed document shows both and never a combined figure.
 */
export type QuoteTotals = {
  oneTime: number;
  monthly: number;
};

/**
 * Whether a billing value means "recurring".
 *
 * Tested for 'monthly' rather than against 'one_time', so an unrecognised
 * value — a vocabulary widened later, or an old snapshot holding a retired
 * one — lands in the ONE-TIME total. That direction is deliberate: a figure
 * wrongly counted once is an understatement a rep can see on the sheet, while
 * one wrongly counted as recurring quietly multiplies by twelve in whatever
 * the merchant works out next.
 */
export function isMonthlyBilling(billing: string): boolean {
  return billing === "monthly";
}

/**
 * The cart's running totals, priced from the catalog the rep is looking at.
 *
 * `priceOf` and `billingOf` are passed in rather than read from a Product
 * here, so this stays pure and the component decides where its catalog came
 * from. A product that cannot be priced contributes NOTHING rather than zero —
 * null means "not priced yet", and a line silently worth 0.00 is the figure
 * products.list_price is nullable to prevent. The Save button is what refuses
 * such a cart; this just does not invent a number for it.
 */
export function cartTotals(
  cart: readonly CartDevice[],
  priceOf: (productId: number) => number | null,
  billingOf: (productId: number) => string,
): QuoteTotals {
  let oneTime = 0;
  let monthly = 0;

  for (const line of cartLines(cart)) {
    const price = priceOf(line.productId);
    if (price === null) continue;
    const amount = price * line.quantity;
    if (isMonthlyBilling(billingOf(line.productId))) monthly += amount;
    else oneTime += amount;
  }

  return { oneTime, monthly };
}

/**
 * The two totals of a SAVED quote, from the snapshot.
 *
 * Reads `line_total` (the stored generated column) and `product_billing` (the
 * snapshot), so a printed proposal's totals are what the merchant was shown
 * even after the catalog reprices or moves a product between billing cycles.
 * Nothing here touches `products`.
 */
export function lineTotals(lines: readonly QuoteLineItem[]): QuoteTotals {
  let oneTime = 0;
  let monthly = 0;

  for (const line of lines) {
    const amount = money(line.line_total);
    if (isMonthlyBilling(line.product_billing)) monthly += amount;
    else oneTime += amount;
  }

  return { oneTime, monthly };
}

/** A saved quote's lines, regrouped into devices and the add-ons under them. */
export type QuoteLineGroup = {
  /** Null for add-on lines that precede any device — see below. */
  device: QuoteLineItem | null;
  addons: QuoteLineItem[];
};

/**
 * Rebuilds the device/add-on structure of a SAVED quote from its snapshot.
 *
 * Two snapshotted facts and nothing else: the lines in `sort_order`, and each
 * line's `product_kind`. A device line opens a group; the add-on lines
 * following it belong to it. That is exactly the order `cartToPayload` emits
 * and `create_quote_version()` preserves through `with ordinality`.
 *
 * Deliberately NOT a live join against product_compatibility. That would make
 * a sent proposal re-group itself when an admin unlinks an accessory — a
 * document changing shape after it was handed over, which is the one thing the
 * append-only design exists to prevent.
 *
 * THE LEADING-ADD-ON CASE IS HANDLED RATHER THAN ASSUMED AWAY. The store
 * cannot produce it (an add-on is only reachable underneath a device), but a
 * direct insert can, and so can a quote written before this grouping existed
 * where every line is a device anyway. Such lines land in a group with
 * `device: null` and are rendered at the top level — legible, rather than
 * silently dropped or attached to a device the rep never chose.
 */
export function groupQuoteLines(
  lines: readonly QuoteLineItem[],
): QuoteLineGroup[] {
  const ordered = [...lines].sort(
    (a, b) => a.sort_order - b.sort_order || a.id - b.id,
  );

  const groups: QuoteLineGroup[] = [];
  for (const line of ordered) {
    if (line.product_kind === "addon") {
      const open = groups[groups.length - 1];
      if (open !== undefined) {
        open.addons.push(line);
        continue;
      }
      // An add-on with no device above it. Its own group, with no device.
      groups.push({ device: null, addons: [line] });
      continue;
    }
    // Anything not marked as an add-on opens a group, including a value
    // outside the vocabulary — a widened `kind` should read as a standalone
    // item rather than disappear under the previous device.
    groups.push({ device: line, addons: [] });
  }

  return groups;
}

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
 * Why a cart cannot be saved, or null if it can.
 *
 * Mirrors create_quote_version()'s own refusals rather than replacing them —
 * the RPC is the boundary and raises inside the transaction that would write
 * the quote. What this buys is the Save button explaining itself instead of
 * the rep clicking it and reading a Postgres exception.
 *
 * `unpriceable` is passed in rather than derived, because this file has no
 * catalog: the component knows which of its own products have no list price,
 * and the RPC refuses exactly those. Without it a rep builds a cart, clicks
 * Save and reads "every line item must name a product that has a list price"
 * with no indication of which line.
 */
export function cartProblem(
  cart: readonly CartDevice[],
  unpriceable?: (productId: number) => boolean,
): string | null {
  if (cart.length === 0) {
    return "Add at least one device.";
  }

  const lines = cartLines(cart);
  if (
    lines.some((line) => !Number.isInteger(line.quantity) || line.quantity < 1)
  ) {
    return "Every line needs a whole quantity of at least 1.";
  }

  if (unpriceable !== undefined) {
    const bad = lines.find((line) => unpriceable(line.productId));
    if (bad !== undefined) {
      return "One of these has no list price yet, so it cannot go on a proposal. Remove it, or ask an admin to price it.";
    }
  }

  return null;
}

/**
 * Rebuilds the cart from a saved version's lines, for a revision.
 *
 * Pre-filled from the SNAPSHOT rather than from the catalog, so a revision
 * starts from what the merchant was actually shown. Quantities carry across;
 * prices do not, because create_quote_version() re-reads them server-side —
 * a revision therefore picks up the current list price, which is what revising
 * a quote means.
 *
 * Uses groupQuoteLines(), so the one definition of "which add-on belonged to
 * which device" serves the builder and the printed document both. A second
 * spelling here is how a revision comes to nest the add-ons differently from
 * the sheet the rep is looking at.
 */
export function cartFromLines(lines: readonly QuoteLineItem[]): CartDevice[] {
  return groupQuoteLines(lines)
    .filter((group) => group.device !== null)
    .map((group) => ({
      // Non-null by the filter above. A leading add-on group has no device to
      // revise under, so it is dropped rather than promoted into one — the
      // store cannot produce that shape, and inventing a device for it would
      // put a product in the cart the rep never chose.
      productId: group.device!.product_id,
      quantity: group.device!.quantity,
      addons: group.addons.map((addon) => ({
        productId: addon.product_id,
        quantity: addon.quantity,
      })),
    }));
}
