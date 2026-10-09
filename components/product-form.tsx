"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { type Brand, diffLinks } from "@/lib/brands";
import {
  PRODUCT_BILLINGS,
  PRODUCT_BILLING_LABELS,
  PRODUCT_KINDS,
  PRODUCT_KIND_LABELS,
  type Product,
  type ProductBilling,
  type ProductKind,
  isProductBilling,
  isProductKind,
  normalizeSku,
  parsePriceInput,
  priceNumber,
} from "@/lib/products";
import {
  DeviceMultiSelect,
  type DeviceOption,
} from "@/components/device-multi-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * One product, typed in by hand: the add form on a brand's page, and the same
 * form opened over an existing row to edit it.
 *
 * Plain PostgREST writes backed by the products and product_compatibility
 * "admin" policies — there is nothing privileged here for a function to do.
 * Editing in place is right for the catalog and would be wrong on quotes:
 * quote_line_items snapshots the name, sku and price at quote time, so no
 * quote depends on this row's history.
 *
 * `specs` is not offered as raw JSON any more. Connectivity is the one key the
 * catalog actually uses, so it is a field; every OTHER key already on the row
 * (the loader's `review` note, anything an admin added before) is carried
 * through untouched on save, because that column exists to be extended without
 * a migration and an edit form must not quietly delete an extension.
 */
export function ProductForm({
  product,
  brand,
  brands,
  categorySuggestions,
  deviceOptions,
  deviceNames,
  fitsDeviceIds,
  onDone,
  onCancel,
}: {
  /** The row being edited, or null to create one. */
  product: Product | null;
  /** The brand a NEW product is filed under. Ignored when editing. */
  brand: string | null;
  /** Every brand, for moving a product between them when editing. */
  brands: readonly Brand[];
  categorySuggestions: readonly string[];
  /** This brand's live devices — what an add-on may be linked to. */
  deviceOptions: readonly DeviceOption[];
  deviceNames: Readonly<Record<number, string>>;
  /** The devices this add-on is already recorded as fitting. */
  fitsDeviceIds: readonly number[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const formId = useId();
  const field = (name: string) => `${formId}-${name}`;

  const [name, setName] = useState(product?.name ?? "");
  const [sku, setSku] = useState(product?.sku ?? "");
  const [category, setCategory] = useState(product?.category ?? "");
  const [brandName, setBrandName] = useState(product?.brand ?? brand ?? "");
  // Guarded rather than cast, for the reason isProductKind() exists: the
  // columns hold a known value, but PostgREST types them as string.
  const [kind, setKind] = useState<ProductKind>(
    product && isProductKind(product.kind) ? product.kind : "device",
  );
  const [billing, setBilling] = useState<ProductBilling>(
    product && isProductBilling(product.billing) ? product.billing : "one_time",
  );
  const [price, setPrice] = useState(
    product ? (priceNumber(product.list_price)?.toFixed(2) ?? "") : "",
  );
  const [connectivity, setConnectivity] = useState(
    typeof product?.specs?.connectivity === "string"
      ? product.specs.connectivity
      : "",
  );
  const [description, setDescription] = useState(product?.description ?? "");
  const [fits, setFits] = useState<number[]>([...fitsDeviceIds]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const ready = name.trim() !== "" && category.trim() !== "";

  const save = async () => {
    setError(null);

    // Same rules as before the redesign, from the same function: blank is
    // NULL ("not priced yet"), never 0.00, because Number("") is 0 and an
    // unpriced terminal on a quote would read as free.
    const parsedPrice = parsePriceInput(price);
    if (parsedPrice.error) {
      setError(parsedPrice.error);
      return;
    }

    const specs: Record<string, unknown> = { ...(product?.specs ?? {}) };
    if (connectivity.trim() === "") delete specs.connectivity;
    else specs.connectivity = connectivity.trim();

    const row = {
      name: name.trim(),
      // '' is never stored: idx_products_sku is partial on `sku is not null`,
      // so two cleared skus would collide. See normalizeSku().
      sku: normalizeSku(sku),
      category: category.trim(),
      // An FK to brands(name). The select only offers names that exist; the
      // FK is what refuses one that was deleted while this form was open.
      brand: product ? (brandName === "" ? null : brandName) : brand,
      kind,
      billing,
      list_price: parsedPrice.value,
      description: description.trim() === "" ? null : description.trim(),
      specs,
    };

    // A device has no compatibility list of its own — the relation is
    // recorded on the add-on — so an add-on turned into a device sheds its
    // links rather than keeping rows the store can never read.
    const wanted = kind === "addon" ? fits : [];
    const { add, remove } = diffLinks(fitsDeviceIds, wanted);

    setBusy(true);
    const supabase = createClient();

    let productId = product?.id ?? null;

    // Deletes first: they are valid whatever the kind, and an add-on being
    // turned into a device must shed its links before it stops being one.
    if (productId !== null && remove.length > 0) {
      const { error: unlinkError } = await supabase
        .from("product_compatibility")
        .delete()
        .eq("addon_product_id", productId)
        .in("device_product_id", remove);
      if (unlinkError) return fail(unlinkError.message);
    }

    if (productId === null) {
      const { data, error: insertError } = await supabase
        .from("products")
        .insert(row)
        .select("id")
        .single();
      if (insertError || !data) {
        return fail(insertError?.message ?? "The product was not created.");
      }
      productId = data.id as number;
    } else {
      const { error: updateError } = await supabase
        .from("products")
        .update(row)
        .eq("id", productId);
      if (updateError) return fail(updateError.message);
    }

    // Inserts last, once the row is an add-on in the database:
    // enforce_compatibility_kinds() reads the STORED kind, so linking before
    // the kind change lands would be refused.
    if (add.length > 0) {
      const { error: linkError } = await supabase
        .from("product_compatibility")
        .insert(
          add.map((deviceId) => ({
            addon_product_id: productId,
            device_product_id: deviceId,
          })),
        );
      if (linkError) {
        // The product itself saved. Said plainly, so the admin re-opens it to
        // retry the links rather than adding the product a second time.
        setBusy(false);
        setError(
          `The product was saved, but its devices were not linked: ${linkError.message}`,
        );
        router.refresh();
        return;
      }
    }

    setBusy(false);
    router.refresh();
    onDone();
  };

  const fail = (message: string) => {
    setBusy(false);
    setError(
      /idx_products_sku/.test(message)
        ? "Another product already uses that model / SKU."
        : message,
    );
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) void save();
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor={field("name")}>Name</Label>
          <Input
            id={field("name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Clover Flex"
          />
        </div>
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor={field("sku")}>Model / SKU</Label>
          <Input
            id={field("sku")}
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            placeholder="C401U"
          />
        </div>
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor={field("category")}>Type</Label>
          {/* A datalist, not a select: `category` is free text on purpose, so
              a new kind of hardware needs no migration. */}
          <Input
            id={field("category")}
            list={field("category-suggestions")}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="Countertop terminals"
          />
          <datalist id={field("category-suggestions")}>
            {categorySuggestions.map((item) => (
              <option key={item} value={item} />
            ))}
          </datalist>
        </div>
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor={field("price")}>List price</Label>
          <Input
            id={field("price")}
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="Blank = not priced yet"
            inputMode="decimal"
          />
        </div>
        {/* Selects, not free text: kind and billing are read by CODE — the
            compatibility trigger, the store, the proposal's two totals — so an
            invented value is a row all three silently skip. */}
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor={field("kind")}>Kind</Label>
          <select
            id={field("kind")}
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
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor={field("billing")}>Billing</Label>
          <select
            id={field("billing")}
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
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor={field("connectivity")}>Connectivity</Label>
          <Input
            id={field("connectivity")}
            value={connectivity}
            onChange={(e) => setConnectivity(e.target.value)}
            placeholder="Wi-Fi / 4G"
          />
        </div>
        {/* Only when editing. A new product is filed under the brand whose
            page it was added from; moving one is an edit. */}
        {product && (
          <div className="grid min-w-0 gap-1.5">
            <Label htmlFor={field("brand")}>Brand</Label>
            <select
              id={field("brand")}
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={brandName}
              onChange={(e) => setBrandName(e.target.value)}
            >
              <option value="">No brand</option>
              {brands.map((b) => (
                <option key={b.id} value={b.name}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={field("description")}>Description</Label>
        <Textarea
          id={field("description")}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
        />
      </div>

      {kind === "addon" && (
        <div className="grid gap-1.5">
          <Label htmlFor={field("fits")}>Fits these devices</Label>
          <DeviceMultiSelect
            id={field("fits")}
            options={deviceOptions}
            selected={fits}
            names={deviceNames}
            onChange={setFits}
            disabled={busy}
          />
          {/* An add-on reaches a rep ONLY underneath a device it is linked
              to, so one with no links is invisible in the store. */}
          {fits.length === 0 && (
            <p className="text-xs text-muted-foreground">
              An add-on that fits nothing is not offered in the store.
            </p>
          )}
        </div>
      )}

      {typeof product?.specs?.review === "string" && (
        <p className="text-xs text-muted-foreground">
          Review note: {product.specs.review}
        </p>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy || !ready}>
          {busy ? "Saving…" : product ? "Save changes" : "Add product"}
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        {!ready && (
          <span className="text-xs text-muted-foreground">
            A name and a type are required.
          </span>
        )}
      </div>
    </form>
  );
}
