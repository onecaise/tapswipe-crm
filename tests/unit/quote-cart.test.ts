import { describe, expect, it } from "vitest";

import {
  type CartDevice,
  type QuoteLineItem,
  cartFromLines,
  cartLines,
  cartProblem,
  cartToPayload,
  cartTotals,
  groupQuoteLines,
  isMonthlyBilling,
  lineTotals,
  quotePrintHref,
} from "@/lib/quotes";

/**
 * The cart, the two totals, and the device/add-on grouping.
 *
 * All pure, and all of it the half of the store that can be wrong without
 * anything failing. The scoping and the price lock are in
 * tests/rls/quote-owners-and-price-lock.test.ts, against real policies; the
 * rendered store is in e2e/quote-store.spec.ts. What is left here is
 * arithmetic and ORDER — and the order is not cosmetic, because a saved
 * proposal's structure is reconstructed from (sort_order, product_kind) and
 * nothing else.
 */

/** A catalog as the two lookup functions see it: price and billing by id. */
const CATALOG: Record<number, { price: number | null; billing: string }> = {
  1: { price: 499, billing: "one_time" }, // terminal
  2: { price: 149.5, billing: "one_time" }, // pin pad
  3: { price: 19, billing: "monthly" }, // dock, recurring
  4: { price: 9.99, billing: "monthly" }, // gateway, recurring
  5: { price: null, billing: "one_time" }, // unpriced
};

const priceOf = (id: number) => CATALOG[id]?.price ?? null;
const billingOf = (id: number) => CATALOG[id]?.billing ?? "one_time";

function device(
  productId: number,
  quantity = 1,
  addons: { productId: number; quantity: number }[] = [],
): CartDevice {
  return { productId, quantity, addons };
}

function line(over: Partial<QuoteLineItem> & { id: number }): QuoteLineItem {
  return {
    quote_id: 1,
    product_id: over.id,
    quantity: 1,
    unit_price: "100.00",
    product_name: `Product ${over.id}`,
    product_sku: null,
    product_billing: "one_time",
    product_kind: "device",
    line_total: "100.00",
    sort_order: 0,
    ...over,
  };
}

describe("cartToPayload — the order IS the grouping", () => {
  it("emits each device immediately followed by its own add-ons", () => {
    // Load-bearing rather than cosmetic. create_quote_version() writes
    // sort_order from this array's order, and groupQuoteLines() reads the
    // device/add-on structure back off (sort_order, product_kind). If this
    // interleaved the devices, every saved proposal would nest wrongly.
    const cart = [
      device(1, 2, [{ productId: 3, quantity: 1 }]),
      device(2, 1, [
        { productId: 3, quantity: 2 },
        { productId: 4, quantity: 1 },
      ]),
    ];

    expect(cartToPayload(cart)).toEqual([
      { product_id: 1, quantity: 2 },
      { product_id: 3, quantity: 1 },
      { product_id: 2, quantity: 1 },
      { product_id: 3, quantity: 2 },
      { product_id: 4, quantity: 1 },
    ]);
  });

  it("sends product_id and quantity and NOTHING else", () => {
    // A client-supplied unit_price would be the documents.file_key shape
    // again — a figure no policy reads, on a document handed to a merchant.
    // The RPC has no parameter for one and the trigger would overwrite it, but
    // the payload should not carry a price in the first place.
    const payload = cartToPayload([device(1, 1, [{ productId: 3, quantity: 1 }])]);
    for (const entry of payload) {
      expect(Object.keys(entry).sort()).toEqual(["product_id", "quantity"]);
    }
  });

  it("is empty for an empty cart, rather than throwing", () => {
    expect(cartToPayload([])).toEqual([]);
    expect(cartLines([])).toEqual([]);
  });

  it("keeps a device with no add-ons as a single line", () => {
    expect(cartToPayload([device(1, 3)])).toEqual([
      { product_id: 1, quantity: 3 },
    ]);
  });
});

describe("cartTotals — the monthly split", () => {
  it("separates one-time from monthly rather than summing them", () => {
    // $1,147.50 of terminals and $19 a month are not the same unit. A single
    // figure adding them means nothing and reads as a price.
    const cart = [
      device(1, 2, [{ productId: 3, quantity: 1 }]), // 2×499 + 1×19/mo
      device(2, 1), // 1×149.50
    ];

    expect(cartTotals(cart, priceOf, billingOf)).toEqual({
      oneTime: 1147.5,
      monthly: 19,
    });
  });

  it("counts an add-on's quantity, not just the device's", () => {
    const cart = [device(1, 1, [{ productId: 3, quantity: 3 }])];
    expect(cartTotals(cart, priceOf, billingOf)).toEqual({
      oneTime: 499,
      monthly: 57,
    });
  });

  it("puts a MONTHLY DEVICE in the monthly total, not the one-time one", () => {
    // billing is a fact about the product and kind is a different fact, so a
    // device can be recurring (a gateway) and an add-on can be one-off (a
    // case). Anything keying the split off `kind` instead of `billing` passes
    // every other test in this block and fails this one.
    const cart = [device(4, 2, [{ productId: 2, quantity: 1 }])];
    expect(cartTotals(cart, priceOf, billingOf)).toEqual({
      oneTime: 149.5,
      monthly: 19.98,
    });
  });

  it("is zero on both sides for an empty cart", () => {
    expect(cartTotals([], priceOf, billingOf)).toEqual({
      oneTime: 0,
      monthly: 0,
    });
  });

  it("contributes NOTHING for an unpriced product, not zero", () => {
    // Which look identical in the total and are not the same claim: null means
    // "not priced yet" and a line silently worth 0.00 is the figure
    // products.list_price is nullable to prevent. The Save button refuses such
    // a cart; this just does not invent a number for it.
    const cart = [device(1, 1, [{ productId: 5, quantity: 4 }])];
    expect(cartTotals(cart, priceOf, billingOf)).toEqual({
      oneTime: 499,
      monthly: 0,
    });
  });

  it("treats an unknown billing value as ONE-TIME", () => {
    // The safe direction, deliberately. A figure wrongly counted once is an
    // understatement a rep can see on the sheet; one wrongly counted as
    // recurring quietly multiplies by twelve in whatever the merchant works
    // out next.
    expect(isMonthlyBilling("monthly")).toBe(true);
    expect(isMonthlyBilling("one_time")).toBe(false);
    expect(isMonthlyBilling("annual")).toBe(false);
    expect(isMonthlyBilling("")).toBe(false);

    const totals = cartTotals([device(1)], priceOf, () => "quarterly");
    expect(totals).toEqual({ oneTime: 499, monthly: 0 });
  });
});

describe("lineTotals — a SAVED proposal's two totals", () => {
  it("reads the snapshot, so it survives the catalog moving on", () => {
    // line_total is the stored generated column and product_billing is the
    // snapshot. Nothing here touches `products`: an admin moving a gateway to
    // monthly must not move a figure between the totals of a proposal that was
    // already sent.
    const lines = [
      line({ id: 1, line_total: "998.00", product_billing: "one_time" }),
      line({ id: 2, line_total: "57.00", product_billing: "monthly" }),
      line({ id: 3, line_total: "149.50", product_billing: "one_time" }),
    ];

    expect(lineTotals(lines)).toEqual({ oneTime: 1147.5, monthly: 57 });
  });

  it("puts an unrecognised snapshot value in the one-time total", () => {
    // product_billing deliberately carries NO CHECK — these rows are history,
    // so a value retired from the catalog's vocabulary is correct. It has to
    // render and total rather than crash or vanish.
    expect(
      lineTotals([line({ id: 1, line_total: "50.00", product_billing: "annual" })]),
    ).toEqual({ oneTime: 50, monthly: 0 });
  });

  it("is zero on both sides for no lines", () => {
    expect(lineTotals([])).toEqual({ oneTime: 0, monthly: 0 });
  });
});

describe("groupQuoteLines — rebuilding the structure from the snapshot", () => {
  it("opens a group at each device and attaches the add-ons after it", () => {
    const lines = [
      line({ id: 10, sort_order: 0, product_kind: "device" }),
      line({ id: 11, sort_order: 1, product_kind: "addon" }),
      line({ id: 12, sort_order: 2, product_kind: "addon" }),
      line({ id: 13, sort_order: 3, product_kind: "device" }),
      line({ id: 14, sort_order: 4, product_kind: "addon" }),
    ];

    const groups = groupQuoteLines(lines);
    expect(groups).toHaveLength(2);
    expect(groups[0].device?.id).toBe(10);
    expect(groups[0].addons.map((a) => a.id)).toEqual([11, 12]);
    expect(groups[1].device?.id).toBe(13);
    expect(groups[1].addons.map((a) => a.id)).toEqual([14]);
  });

  it("sorts by sort_order rather than trusting the input order", () => {
    // The page orders its query, but the grouping must not depend on that: a
    // caller passing rows in id order would otherwise nest them wrongly.
    const groups = groupQuoteLines([
      line({ id: 14, sort_order: 4, product_kind: "addon" }),
      line({ id: 10, sort_order: 0, product_kind: "device" }),
      line({ id: 13, sort_order: 3, product_kind: "device" }),
      line({ id: 11, sort_order: 1, product_kind: "addon" }),
    ]);

    expect(groups.map((g) => g.device?.id)).toEqual([10, 13]);
    expect(groups[0].addons.map((a) => a.id)).toEqual([11]);
    expect(groups[1].addons.map((a) => a.id)).toEqual([14]);
  });

  it("breaks a sort_order tie by id, so the order is total", () => {
    // sort_order is deliberately not unique — a duplicate rank is a cosmetic
    // tie, and a constraint rejecting a proposal over it would be worse. So
    // the tie has to be broken here or the grouping reshuffles between
    // renders.
    const groups = groupQuoteLines([
      line({ id: 22, sort_order: 0, product_kind: "device" }),
      line({ id: 21, sort_order: 0, product_kind: "device" }),
    ]);
    expect(groups.map((g) => g.device?.id)).toEqual([21, 22]);
  });

  it("handles a device with no add-ons", () => {
    const groups = groupQuoteLines([
      line({ id: 1, sort_order: 0, product_kind: "device" }),
      line({ id: 2, sort_order: 1, product_kind: "device" }),
    ]);
    expect(groups.map((g) => g.addons.length)).toEqual([0, 0]);
  });

  it("gives a LEADING add-on its own group rather than dropping it", () => {
    // The store cannot produce this (an add-on is only reachable under a
    // device), but a direct insert can. Legible beats silently dropped or
    // attached to a device the rep never chose.
    const groups = groupQuoteLines([
      line({ id: 1, sort_order: 0, product_kind: "addon" }),
      line({ id: 2, sort_order: 1, product_kind: "device" }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0].device).toBeNull();
    expect(groups[0].addons.map((a) => a.id)).toEqual([1]);
    expect(groups[1].device?.id).toBe(2);
  });

  it("treats an unrecognised kind as a standalone item", () => {
    // Same direction loadQuoteContext takes when it splits the catalog: a
    // widened `kind` should read as its own line rather than disappear under
    // the previous device.
    const groups = groupQuoteLines([
      line({ id: 1, sort_order: 0, product_kind: "device" }),
      line({ id: 2, sort_order: 1, product_kind: "bundle" }),
    ]);
    expect(groups.map((g) => g.device?.id)).toEqual([1, 2]);
  });

  it("is empty for no lines", () => {
    expect(groupQuoteLines([])).toEqual([]);
  });
});

describe("cartFromLines — a revision starts from what was shown", () => {
  it("round-trips the nesting through the payload and back", () => {
    // The property that matters: what the rep built, saved and then revised is
    // the same shape. cartFromLines uses groupQuoteLines, so one definition of
    // the grouping serves the builder and the printed sheet both.
    const cart = [
      device(1, 2, [{ productId: 3, quantity: 1 }]),
      device(2, 1, [{ productId: 4, quantity: 5 }]),
    ];

    // Saved, as create_quote_version() would write them.
    const saved = cartToPayload(cart).map((entry, index) =>
      line({
        id: 100 + index,
        product_id: entry.product_id,
        quantity: entry.quantity,
        sort_order: index,
        product_kind: index === 0 || index === 2 ? "device" : "addon",
      }),
    );

    expect(cartFromLines(saved)).toEqual(cart);
  });

  it("carries quantities across but not prices", () => {
    // A revision picks up the CURRENT list price, which is what revising means
    // — so the cart holds ids and quantities and nothing priced.
    const rebuilt = cartFromLines([
      line({ id: 1, product_id: 7, quantity: 4, sort_order: 0, unit_price: "1.00" }),
    ]);
    expect(rebuilt).toEqual([{ productId: 7, quantity: 4, addons: [] }]);
  });

  it("drops a leading add-on rather than inventing a device for it", () => {
    // There is no device to revise it under, and promoting it would put a
    // product in the cart the rep never chose.
    const rebuilt = cartFromLines([
      line({ id: 1, product_id: 3, sort_order: 0, product_kind: "addon" }),
      line({ id: 2, product_id: 1, sort_order: 1, product_kind: "device" }),
    ]);
    expect(rebuilt).toEqual([{ productId: 1, quantity: 1, addons: [] }]);
  });

  it("is empty for no lines", () => {
    expect(cartFromLines([])).toEqual([]);
  });
});

describe("cartProblem — why Save is disabled", () => {
  it("accepts a well-formed cart", () => {
    expect(cartProblem([device(1, 1, [{ productId: 3, quantity: 2 }])])).toBeNull();
  });

  it("refuses an empty cart, naming a DEVICE as the thing to add", () => {
    // Not "a line item": a rep cannot add an add-on first, so telling them to
    // add one would be describing an action the store does not offer.
    expect(cartProblem([])).toMatch(/device/i);
  });

  it("refuses a quantity below one, anywhere in the nesting", () => {
    expect(cartProblem([device(1, 0)])).toMatch(/quantity/i);
    expect(cartProblem([device(1, 1, [{ productId: 3, quantity: 0 }])])).toMatch(
      /quantity/i,
    );
    expect(cartProblem([device(1, 1.5)])).toMatch(/quantity/i);
  });

  it("refuses an unpriced product when told which ones those are", () => {
    // Only reachable through a revision — the store offers nothing unpriced,
    // but a revision is pre-filled from the snapshot, so a product priced when
    // the quote was sent and unpriced now comes back into the cart. Without
    // this the save fails server-side with a message naming no line.
    const unpriceable = (id: number) => id === 5;
    expect(cartProblem([device(1, 1, [{ productId: 5, quantity: 1 }])], unpriceable))
      .toMatch(/list price/i);
    // And the same cart is fine when nothing is flagged, which is what says
    // the refusal came from the predicate rather than from the shape.
    expect(
      cartProblem([device(1, 1, [{ productId: 5, quantity: 1 }])]),
    ).toBeNull();
  });

  it("reports the quantity problem before the price one", () => {
    // Both wrong at once: the quantity is the one the rep can fix in the row
    // they are looking at, so it is the one worth saying.
    expect(cartProblem([device(5, 0)], (id) => id === 5)).toMatch(/quantity/i);
  });
});

describe("quotePrintHref — one definition of the print URL", () => {
  it("routes both owner kinds to a page that exists", () => {
    expect(quotePrintHref("lead", 7, "group-a")).toBe(
      "/leads/7/quotes/group-a/print",
    );
    expect(quotePrintHref("merchant", 7, "group-a")).toBe(
      "/merchants/7/quotes/group-a/print",
    );
  });

  it("keeps the two distinct — same id, different owner, different route", () => {
    // Lead 7 and merchant 7 both exist. Anything keying on the id alone sends
    // a rep to the wrong business's proposal.
    expect(quotePrintHref("lead", 7, "g")).not.toBe(
      quotePrintHref("merchant", 7, "g"),
    );
  });

  it("omits ?quote= without a version, and pins it with one", () => {
    // The bare group URL prints whatever is CURRENT, which is what a list row
    // wants; an explicit ?quote= pins one version, which is what a history row
    // wants. A list row pinned to today's row id would keep printing this
    // version after the next revision.
    expect(quotePrintHref("lead", 1, "g")).not.toContain("?");
    expect(quotePrintHref("lead", 1, "g", 42)).toBe(
      "/leads/1/quotes/g/print?quote=42",
    );
  });
});
