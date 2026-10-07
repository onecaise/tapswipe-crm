"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArchiveIcon, ArchiveRestoreIcon, SaveIcon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { formatMoney } from "@/lib/format";
// SUGGESTED_PRODUCT_CATEGORIES is deliberately NOT imported here: the category
// input below points at #product-category-suggestions, which ProductCreateForm
// renders once on the same page. Declaring a second copy per row would mean
// one duplicate element id per product.
import {
  PRODUCT_BILLINGS,
  PRODUCT_BILLING_LABELS,
  PRODUCT_KINDS,
  PRODUCT_KIND_LABELS,
  type Product,
  type ProductBilling,
  type ProductKind,
  formatSpecs,
  isProductBilling,
  isProductKind,
  normalizeBrand,
  normalizeSku,
  parsePriceInput,
  parseSpecsInput,
  priceNumber,
} from "@/lib/products";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/**
 * One row of the admin's catalog list: rename, reprice, recategorise, archive.
 *
 * All of it is plain PostgREST updates backed by the "admin updates" policy.
 * There is no delete, here or anywhere: a product exists to be referenced by
 * quote_line_items, and a quote is evidence of what a merchant was offered.
 * The table has no DELETE policy and no DELETE grant, so this is not a UI
 * omission a future button could quietly undo.
 *
 * Editing IN PLACE is correct here and would be wrong on quotes, which is the
 * distinction worth holding on to. A quote is a document that was handed to
 * somebody, so an edit has to produce a new version; the catalog is current
 * state, and no quote depends on its history because quote_line_items
 * snapshots the name, sku and price at quote time.
 */
export function ProductAdminRow({
  product,
  devices,
  fitsDeviceIds,
}: {
  product: Product;
  /**
   * Every live device in the catalog, for an add-on's compatibility list.
   *
   * Passed from the page rather than fetched per row: forty add-ons would be
   * forty identical reads of the same list. Live only — linking an add-on to
   * an archived device records a pairing the store can never offer, because an
   * archived device is not in it.
   */
  devices: Product[];
  /** The device ids this add-on is already recorded as fitting. */
  fitsDeviceIds: number[];
}) {
  const [name, setName] = useState(product.name);
  const [sku, setSku] = useState(product.sku ?? "");
  const [category, setCategory] = useState(product.category);
  const [brand, setBrand] = useState(product.brand ?? "");
  // Guarded rather than cast: the column is `not null` with a CHECK, so these
  // always hold a known value in practice — but PostgREST types them as
  // `string`, and a widened vocabulary should fall back to a sane control
  // rather than render a select with no matching option.
  const [kind, setKind] = useState<ProductKind>(
    isProductKind(product.kind) ? product.kind : "device",
  );
  const [billing, setBilling] = useState<ProductBilling>(
    isProductBilling(product.billing) ? product.billing : "one_time",
  );
  const [price, setPrice] = useState(
    priceNumber(product.list_price)?.toFixed(2) ?? "",
  );
  const [description, setDescription] = useState(product.description ?? "");
  const [specs, setSpecs] = useState(formatSpecs(product.specs));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const router = useRouter();

  const isArchived = product.archived_at !== null;
  const currentPrice = priceNumber(product.list_price);

  const dirty =
    name.trim() !== product.name ||
    normalizeSku(sku) !== product.sku ||
    category.trim() !== product.category ||
    normalizeBrand(brand) !== product.brand ||
    kind !== product.kind ||
    billing !== product.billing ||
    price.trim() !== (currentPrice?.toFixed(2) ?? "") ||
    description.trim() !== (product.description ?? "") ||
    specs.trim() !== formatSpecs(product.specs).trim();

  const save = async () => {
    if (name.trim() === "" || category.trim() === "") {
      setError("Name and category are both required.");
      return;
    }

    const parsedPrice = parsePriceInput(price);
    if (parsedPrice.error) {
      setError(parsedPrice.error);
      return;
    }
    const parsedSpecs = parseSpecsInput(specs);
    if (parsedSpecs.error) {
      setError(parsedSpecs.error);
      return;
    }

    setBusy(true);
    setError(null);

    const supabase = createClient();
    const { error: updateError } = await supabase
      .from("products")
      .update({
        // Trimmed: category is rendered as a grouping heading, so "Accessories"
        // and "Accessories " would split the catalog into two sections that
        // look identical.
        name: name.trim(),
        sku: normalizeSku(sku),
        category: category.trim(),
        brand: normalizeBrand(brand),
        kind,
        billing,
        list_price: parsedPrice.value,
        description: description.trim() === "" ? null : description.trim(),
        specs: parsedSpecs.value,
      })
      .eq("id", product.id);

    if (updateError) {
      setError(updateError.message);
      setBusy(false);
      return;
    }

    setBusy(false);
    router.refresh();
  };

  const setArchived = async (archived: boolean) => {
    setBusy(true);
    setError(null);

    const supabase = createClient();
    const { error: updateError } = await supabase
      .from("products")
      .update({ archived_at: archived ? new Date().toISOString() : null })
      .eq("id", product.id);

    if (updateError) {
      setError(updateError.message);
      setBusy(false);
      return;
    }

    setBusy(false);
    router.refresh();
  };

  /**
   * Links or unlinks this add-on from one device.
   *
   * A DELETE and an INSERT rather than an upsert, because the row IS the fact
   * — there is nothing to update. product_compatibility is the one catalog
   * table that allows a delete, and the reason is here: a compatibility row is
   * a current-state claim rather than history, so an admin unticking a device
   * a vendor stopped supporting should remove it, not leave a tombstone every
   * reader has to filter.
   *
   * No optimistic state. The row re-reads through router.refresh(), so what is
   * ticked is always what the database holds — which matters more here than
   * for a text field, because the trigger can REFUSE the insert (an add-on
   * side that is not of kind 'addon'), and an optimistic tick would show a
   * link that does not exist.
   */
  const setFits = async (deviceId: number, fits: boolean) => {
    setBusy(true);
    setError(null);

    const supabase = createClient();
    const { error: writeError } = fits
      ? await supabase.from("product_compatibility").insert({
          addon_product_id: product.id,
          device_product_id: deviceId,
        })
      : await supabase
          .from("product_compatibility")
          .delete()
          .eq("addon_product_id", product.id)
          .eq("device_product_id", deviceId);

    if (writeError) {
      setError(writeError.message);
      setBusy(false);
      return;
    }

    setBusy(false);
    router.refresh();
  };

  const fitsSet = new Set(fitsDeviceIds);

  return (
    <li className="flex flex-col gap-2 p-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1">
            <label
              className="text-xs text-muted-foreground"
              htmlFor={`product-name-${product.id}`}
            >
              Name
            </label>
            <Input
              id={`product-name-${product.id}`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-56"
            />
          </div>
          <div className="grid gap-1">
            <label
              className="text-xs text-muted-foreground"
              htmlFor={`product-sku-${product.id}`}
            >
              Model / SKU
            </label>
            <Input
              id={`product-sku-${product.id}`}
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              className="w-32"
            />
          </div>
          <div className="grid gap-1">
            <label
              className="text-xs text-muted-foreground"
              htmlFor={`product-category-${product.id}`}
            >
              Category
            </label>
            <Input
              id={`product-category-${product.id}`}
              list="product-category-suggestions"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-48"
            />
          </div>
          <div className="grid gap-1">
            <label
              className="text-xs text-muted-foreground"
              htmlFor={`product-brand-${product.id}`}
            >
              Brand
            </label>
            <Input
              id={`product-brand-${product.id}`}
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              className="w-36"
            />
          </div>
          <div className="grid gap-1">
            <label
              className="text-xs text-muted-foreground"
              htmlFor={`product-kind-${product.id}`}
            >
              Kind
            </label>
            <select
              id={`product-kind-${product.id}`}
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={kind}
              onChange={(e) => setKind(e.target.value as ProductKind)}
            >
              {PRODUCT_KINDS.map((value) => (
                <option key={value} value={value}>
                  {PRODUCT_KIND_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1">
            <label
              className="text-xs text-muted-foreground"
              htmlFor={`product-billing-${product.id}`}
            >
              Billing
            </label>
            <select
              id={`product-billing-${product.id}`}
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={billing}
              onChange={(e) => setBilling(e.target.value as ProductBilling)}
            >
              {PRODUCT_BILLINGS.map((value) => (
                <option key={value} value={value}>
                  {PRODUCT_BILLING_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1">
            <label
              className="text-xs text-muted-foreground"
              htmlFor={`product-price-${product.id}`}
            >
              List price
            </label>
            <Input
              id={`product-price-${product.id}`}
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              inputMode="decimal"
              className="w-28"
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Only offered when something changed, so the row does not present
              a save affordance for a no-op write. */}
          {dirty && (
            <Button size="sm" disabled={busy} onClick={() => void save()}>
              <SaveIcon size={14} />
              Save
            </Button>
          )}
          {isArchived ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void setArchived(false)}
            >
              <ArchiveRestoreIcon size={14} />
              Restore
            </Button>
          ) : (
            // Outline, not destructive. Archiving is reversible and takes
            // nothing away — destructive red is reserved for the irreversible,
            // and there is nothing irreversible on this table by design.
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void setArchived(true)}
            >
              <ArchiveIcon size={14} />
              Archive
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{formatMoney(currentPrice)}</span>
        <span>·</span>
        <button
          type="button"
          className="underline underline-offset-2"
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "Hide" : "Description & specs"}
        </button>
        {isArchived && <StatusBadge intent="neutral">Archived</StatusBadge>}
        {/* An unpriced product is legitimate ("call for pricing") and still
            cannot go on a quote — create_quote_version() refuses it rather
            than pricing it at zero. Flagged as a warning rather than an error
            because the fix is an admin typing a number, which is what this
            needs to tell them. */}
        {currentPrice === null && !isArchived && (
          <StatusBadge intent="warning">
            No price — cannot be quoted
          </StatusBadge>
        )}
        {/* An add-on reaches a rep ONLY underneath a device it is linked to,
            so one with no links is invisible in the store however well it is
            priced. Warning rather than error for the same reason the missing
            price is: the fix is an admin ticking a box. */}
        {kind === "addon" && fitsDeviceIds.length === 0 && !isArchived && (
          <StatusBadge intent="warning">
            Fits nothing — not offered in the store
          </StatusBadge>
        )}
      </div>

      {/* Only for add-ons. A device has no compatibility list of its own: the
          relation is recorded once, on the add-on, and the store reads it from
          the device side through idx_product_compatibility_device. Offering
          the mirror image here would be the same fact entered twice. */}
      {kind === "addon" && (
        <fieldset className="flex flex-col gap-1.5 rounded-md border p-2.5">
          <legend className="px-1 text-xs text-muted-foreground">
            Fits these devices
          </legend>
          {devices.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No live devices in the catalog to link to yet.
            </p>
          ) : (
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {devices.map((device) => (
                <label
                  key={device.id}
                  className="flex items-center gap-1.5 text-sm"
                >
                  <input
                    type="checkbox"
                    className="size-4 rounded border"
                    checked={fitsSet.has(device.id)}
                    disabled={busy}
                    onChange={(e) => void setFits(device.id, e.target.checked)}
                  />
                  {device.name}
                </label>
              ))}
            </div>
          )}
          {/* Said out loud because the kind select above is live state: an
              admin can flip a device to Add-on without saving, and the list
              would then be offering links that the trigger refuses. */}
          {kind !== product.kind && (
            <p className="text-xs text-warning">
              Save the kind change first — links are written against what the
              catalog currently holds.
            </p>
          )}
        </fieldset>
      )}

      {/* Collapsed by default: these two are the long fields, and a catalog of
          forty products would otherwise be unscannable. */}
      {expanded && (
        <div className="flex flex-col gap-2">
          <div className="grid gap-1">
            <label
              className="text-xs text-muted-foreground"
              htmlFor={`product-description-${product.id}`}
            >
              Description
            </label>
            <Input
              id={`product-description-${product.id}`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="grid gap-1">
            <label
              className="text-xs text-muted-foreground"
              htmlFor={`product-specs-${product.id}`}
            >
              Specs (JSON object)
            </label>
            <Textarea
              id={`product-specs-${product.id}`}
              value={specs}
              onChange={(e) => setSpecs(e.target.value)}
              rows={4}
              className="font-mono text-xs"
            />
          </div>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </li>
  );
}
