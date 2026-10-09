"use client";

import { useMemo, useState } from "react";
import { MinusIcon, PlusIcon, SearchIcon, Trash2Icon } from "lucide-react";

import { formatMoney } from "@/lib/format";
import {
  PRODUCT_BILLING_LABELS,
  UNBRANDED_LABEL,
  brandOptions,
  categoryOptions,
  isProductBilling,
  matchesProductSearch,
  priceNumber,
  type Product,
} from "@/lib/products";
import {
  cartTotals,
  type CartDevice,
  type DraftLine,
} from "@/lib/quotes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * The store: browse the catalog by brand, drop devices in a cart, hang the
 * add-ons that fit them underneath, and see the two totals.
 *
 * ## Why this is NOT on ListTable, which is the app's responsive list pattern
 *
 * ListTable renders BOTH layouts and hides one with `display:none`, and its
 * own header says what that costs: a locator that does not consult the
 * accessibility tree matches the hidden copy too, and `getByLabel` is the one
 * that bit — converting the payouts ledger to it reddened nine editing specs,
 * every one a getByLabel on a figure input. This component is almost entirely
 * form controls (a quantity stepper per line, an Add button per product), so
 * it would hit that on every one of them.
 *
 * So it follows the same responsive DISCIPLINE with one rendered copy: each
 * row is a `flex-col sm:flex-row` that stacks on a phone, nothing is in a
 * horizontally scrolling container, and `min-w-0` is on every flex child that
 * holds text. Verified at 375, 768 and 1440 — see e2e/quote-store.spec.ts,
 * which asserts no horizontal overflow at all three rather than trusting the
 * classes.
 *
 * ## Only DEVICES are browsable
 *
 * An add-on is reachable only underneath a device it is linked to in
 * product_compatibility. That is the whole point of the join table, and it has
 * a consequence worth stating: an add-on linked to nothing is invisible here
 * however well it is priced. /admin/products flags exactly that case, because
 * the fix is an admin ticking a box.
 *
 * ## Prices are displayed, never sent
 *
 * Every figure here is a preview. The cart sends product_id and quantity, and
 * `create_quote_version()` reads the price off the catalog inside the
 * transaction — then `snapshot_quote_line_item()` re-derives it at a layer no
 * caller can skip. So a tampered-with price in this component changes what the
 * rep sees and nothing that gets saved.
 */

/** Select sentinels. `""` means "no filter"; the brand one needs a second. */
const ALL = "";
/**
 * The unbranded bucket's select value.
 *
 * A sentinel is needed because the filter has THREE states — every brand, one
 * named brand, and the products with no brand at all — and a `<select>` value
 * is a string. `""` is already "all", and the column's own value is null.
 *
 * Double-underscored rather than a control character. The first draft used a
 * literal NUL byte, on the reasoning that no manufacturer could be called
 * that — true, and still wrong twice over: a NUL in a DOM attribute value is
 * not something to rely on, and one anywhere in a file makes git treat the
 * WHOLE FILE as binary, so this component would have had no reviewable diff
 * ever again. (It also cannot be quoted in the comment explaining it, which is
 * how a second copy survived the first fix.) A sentinel only has to be a
 * string no `products.brand` holds, and `products_brand_not_blank` plus a
 * human typing vendor names makes this one safe.
 */
const NO_BRAND = "__unbranded__";

export function QuoteStore({
  devices,
  addons,
  addonsByDevice,
  cart,
  busy,
  onAddDevice,
  onDeviceQuantity,
  onRemoveDevice,
  onAddAddon,
  onAddonQuantity,
  onRemoveAddon,
}: {
  /** Quotable devices — live and priced. The page filters; this displays. */
  devices: Product[];
  /** Quotable add-ons, looked up by id when a device is in the cart. */
  addons: Product[];
  /** device id -> add-on ids recorded as fitting it. */
  addonsByDevice: Map<number, number[]>;
  cart: CartDevice[];
  busy: boolean;
  onAddDevice: (productId: number) => void;
  onDeviceQuantity: (productId: number, quantity: number) => void;
  onRemoveDevice: (productId: number) => void;
  onAddAddon: (deviceId: number, addonId: number) => void;
  onAddonQuantity: (deviceId: number, addonId: number, quantity: number) => void;
  onRemoveAddon: (deviceId: number, addonId: number) => void;
}) {
  const [search, setSearch] = useState("");
  const [brand, setBrand] = useState<string>(ALL);
  const [category, setCategory] = useState<string>(ALL);

  const productOf = useMemo(() => {
    const all = new Map<number, Product>();
    for (const product of [...devices, ...addons]) all.set(product.id, product);
    return all;
  }, [devices, addons]);

  // Filter options come from the DEVICES, because devices are what the browse
  // list holds. Taking them from the whole catalog would offer a brand whose
  // only products are add-ons — a filter that can only ever return nothing.
  const brands = useMemo(() => brandOptions(devices), [devices]);
  const categories = useMemo(() => categoryOptions(devices), [devices]);

  const matching = useMemo(
    () =>
      devices.filter((product) => {
        if (!matchesProductSearch(product, search)) return false;
        if (category !== ALL && product.category !== category) return false;
        if (brand === ALL) return true;
        if (brand === NO_BRAND) return product.brand === null;
        return product.brand === brand;
      }),
    [devices, search, brand, category],
  );

  /** The browse list, grouped by brand so the heading is the browse axis. */
  const grouped = useMemo(() => {
    const byBrand = new Map<string, Product[]>();
    for (const product of matching) {
      const key = product.brand ?? UNBRANDED_LABEL;
      const list = byBrand.get(key);
      if (list) list.push(product);
      else byBrand.set(key, [product]);
    }
    return [...byBrand.entries()]
      .map(([label, list]) => ({
        label,
        products: [...list].sort((a, b) => a.name.localeCompare(b.name)),
      }))
      // UNBRANDED_LABEL last rather than alphabetical: it is a residue, and
      // sorting it between two manufacturers reads as a third manufacturer.
      .sort((a, b) => {
        if (a.label === UNBRANDED_LABEL) return 1;
        if (b.label === UNBRANDED_LABEL) return -1;
        return a.label.localeCompare(b.label);
      });
  }, [matching]);

  const inCart = useMemo(
    () => new Set(cart.map((device) => device.productId)),
    [cart],
  );

  const totals = cartTotals(
    cart,
    (id) => priceNumber(productOf.get(id)?.list_price ?? null),
    (id) => productOf.get(id)?.billing ?? "one_time",
  );

  return (
    <div className="flex flex-col gap-4">
      {/* ---------------------------------------------------------------
          Browse
          --------------------------------------------------------------- */}
      <div className="flex flex-col gap-2">
        <h4 className="text-xs uppercase tracking-wide text-muted-foreground">
          Choose hardware
        </h4>

        {/* Stacks on a phone. The three controls are each full width below sm
            because a 343px row cannot hold a search box and two selects
            without one of them becoming unusable. */}
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <SearchIcon
              size={15}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, model or brand"
              aria-label="Search the catalog"
              className="pl-8"
            />
          </div>

          <select
            className="h-9 rounded-md border bg-background px-2 text-sm sm:w-40"
            value={brand}
            aria-label="Filter by brand"
            onChange={(e) => setBrand(e.target.value)}
          >
            <option value={ALL}>All brands</option>
            {brands.map((value) => (
              <option
                key={value ?? NO_BRAND}
                value={value ?? NO_BRAND}
              >
                {value ?? UNBRANDED_LABEL}
              </option>
            ))}
          </select>

          {/* `category` IS the device type. A second column for it would be
              the same fact twice — see the schema doc. */}
          <select
            className="h-9 rounded-md border bg-background px-2 text-sm sm:w-44"
            value={category}
            aria-label="Filter by device type"
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value={ALL}>All types</option>
            {categories.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>

        {devices.length === 0 ? (
          // The catalog is deliberately unseeded until the real pricing sheet
          // arrives, so this is the expected state rather than an error — and
          // it has to say where the fix lives, because a rep cannot add a
          // product themselves.
          <p className="text-sm text-muted-foreground">
            Nothing in the catalog can go on a proposal yet. An admin adds
            devices, with a list price, under Products.
          </p>
        ) : matching.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No devices match that. Clear the search or the filters.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {grouped.map((group) => (
              <div key={group.label} className="flex flex-col gap-1.5">
                <h5 className="text-xs font-medium">{group.label}</h5>
                <ul className="flex flex-col divide-y rounded-md border">
                  {group.products.map((product) => (
                    <li
                      key={product.id}
                      className="flex flex-col gap-2 p-2.5 sm:flex-row sm:items-center sm:gap-3"
                    >
                      {/* min-w-0 so a long product name wraps rather than
                          forcing the row wider than its card. */}
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm font-medium">
                          {product.name}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {product.category}
                          {product.sku ? ` · ${product.sku}` : ""}
                          {isProductBilling(product.billing) &&
                          product.billing === "monthly"
                            ? " · Monthly"
                            : ""}
                        </span>
                      </div>
                      <span className="shrink-0 text-sm tabular-nums">
                        {formatMoney(priceNumber(product.list_price))}
                      </span>
                      <Button
                        size="sm"
                        variant={inCart.has(product.id) ? "outline" : "default"}
                        disabled={busy}
                        onClick={() => onAddDevice(product.id)}
                        aria-label={`Add ${product.name}`}
                        className="shrink-0"
                      >
                        <PlusIcon size={14} />
                        {inCart.has(product.id) ? "Add another" : "Add"}
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---------------------------------------------------------------
          Cart
          --------------------------------------------------------------- */}
      <div className="flex flex-col gap-2">
        <h4 className="text-xs uppercase tracking-wide text-muted-foreground">
          This proposal
        </h4>

        {cart.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing added yet. Add a device above, and anything that fits it
            will appear underneath.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {cart.map((device) => {
              const product = productOf.get(device.productId);
              const fits = addonsByDevice.get(device.productId) ?? [];
              const chosen = new Set(device.addons.map((a) => a.productId));
              // Only quotable add-ons, and only ones not already chosen: the
              // list is "what else can go on this", so an add-on already in
              // the cart below does not belong in it.
              const offerable = fits
                .map((id) => productOf.get(id))
                .filter(
                  (addon): addon is Product =>
                    addon !== undefined && !chosen.has(addon.id),
                );

              return (
                <li
                  key={device.productId}
                  className="flex flex-col gap-2 rounded-md border p-2.5"
                >
                  <CartRow
                    name={product?.name ?? `Product #${device.productId}`}
                    sku={product?.sku ?? null}
                    price={priceNumber(product?.list_price ?? null)}
                    billing={product?.billing ?? "one_time"}
                    quantity={device.quantity}
                    busy={busy}
                    onQuantity={(q) => onDeviceQuantity(device.productId, q)}
                    onRemove={() => onRemoveDevice(device.productId)}
                  />

                  {/* The add-ons under this device, indented so the
                      relationship is visible on a phone too — where the rows
                      stack and the nesting is the only thing left saying which
                      device they belong to. */}
                  {device.addons.length > 0 && (
                    <ul className="flex flex-col gap-2 border-l pl-3">
                      {device.addons.map((addon) => {
                        const addonProduct = productOf.get(addon.productId);
                        return (
                          <li key={addon.productId}>
                            <CartRow
                              name={
                                addonProduct?.name ??
                                `Product #${addon.productId}`
                              }
                              sku={addonProduct?.sku ?? null}
                              price={priceNumber(
                                addonProduct?.list_price ?? null,
                              )}
                              billing={addonProduct?.billing ?? "one_time"}
                              quantity={addon.quantity}
                              busy={busy}
                              onQuantity={(q) =>
                                onAddonQuantity(
                                  device.productId,
                                  addon.productId,
                                  q,
                                )
                              }
                              onRemove={() =>
                                onRemoveAddon(device.productId, addon.productId)
                              }
                            />
                          </li>
                        );
                      })}
                    </ul>
                  )}

                  {offerable.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 border-l pl-3">
                      <span className="text-xs text-muted-foreground">
                        Fits this:
                      </span>
                      {offerable.map((addon) => (
                        <Button
                          key={addon.id}
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => onAddAddon(device.productId, addon.id)}
                          aria-label={`Add ${addon.name} to ${product?.name ?? "device"}`}
                        >
                          <PlusIcon size={13} />
                          {addon.name}
                          <span className="text-muted-foreground tabular-nums">
                            {formatMoney(priceNumber(addon.list_price))}
                          </span>
                        </Button>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* ---------------------------------------------------------------
          Totals — TWO of them, never summed.
          --------------------------------------------------------------- */}
      {/* The <dl> holds only the two pairs; the note below is a sibling, not a
          child — a <p> inside a <dl> is invalid list markup (QA-006).
          `contents` keeps the pairs laid out by the row exactly as before. */}
      <div className="flex flex-col gap-1 border-t pt-3 text-sm sm:flex-row sm:gap-6">
        <dl className="contents">
          <div className="flex items-baseline gap-2">
            <dt className="text-muted-foreground">One-time</dt>
            <dd className="font-medium tabular-nums">
              {formatMoney(totals.oneTime)}
            </dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="text-muted-foreground">Monthly</dt>
            <dd className="font-medium tabular-nums">
              {formatMoney(totals.monthly)}
            </dd>
          </div>
        </dl>
        {/* No combined figure, here or on the printed sheet. $1,497 of
            terminals and $29 a month are not the same unit, so a single
            "total" summing them would be a number that means nothing and
            reads as a price. */}
        <p className="text-xs text-muted-foreground sm:ml-auto sm:self-center">
          Prices are taken from the catalog when the proposal is saved.
        </p>
      </div>
    </div>
  );
}

/**
 * One line in the cart — device or add-on, the same control either way.
 *
 * Shared rather than two near-copies, because a device row and an add-on row
 * differ only in what sits around them. Two copies is how the add-on stepper
 * comes to behave differently from the device one.
 */
function CartRow({
  name,
  sku,
  price,
  billing,
  quantity,
  busy,
  onQuantity,
  onRemove,
}: {
  name: string;
  sku: string | null;
  price: number | null;
  billing: string;
  quantity: number;
  busy: boolean;
  onQuantity: (quantity: number) => void;
  onRemove: () => void;
}) {
  const monthly = billing === "monthly";

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">{name}</span>
        <span className="text-xs text-muted-foreground">
          {price === null ? "No list price" : formatMoney(price)}
          {monthly ? ` · ${PRODUCT_BILLING_LABELS.monthly}` : ""}
          {sku ? ` · ${sku}` : ""}
        </span>
      </div>

      {/* A stepper AND a number input. Reps are on phones, where a 44px
          target beats typing into a 2-character box — but typing 12 is three
          taps on a stepper and one on a keyboard, so both are offered. */}
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || quantity <= 1}
          onClick={() => onQuantity(quantity - 1)}
          aria-label={`Decrease quantity of ${name}`}
        >
          <MinusIcon size={14} />
        </Button>
        <Input
          type="number"
          min={1}
          step={1}
          value={quantity}
          disabled={busy}
          // Number("") is 0 and an empty box is not a zero, so a cleared
          // field holds its last value rather than collapsing the line to a
          // quantity the RPC refuses.
          onChange={(e) => {
            const next = Number(e.target.value);
            if (Number.isInteger(next) && next >= 1) onQuantity(next);
          }}
          className="w-16 text-center"
          aria-label={`Quantity of ${name}`}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => onQuantity(quantity + 1)}
          aria-label={`Increase quantity of ${name}`}
        >
          <PlusIcon size={14} />
        </Button>
      </div>

      <span className="shrink-0 text-sm font-medium tabular-nums sm:w-24 sm:text-right">
        {formatMoney(price === null ? null : price * quantity)}
      </span>

      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={onRemove}
        aria-label={`Remove ${name}`}
        className="shrink-0 self-start sm:self-auto"
      >
        <Trash2Icon size={14} />
      </Button>
    </div>
  );
}

/** Re-exported so the panel's cart handlers have one place to import from. */
export type { CartDevice, DraftLine };
