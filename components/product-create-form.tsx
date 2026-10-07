"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PlusIcon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import {
  PRODUCT_BILLINGS,
  PRODUCT_BILLING_LABELS,
  PRODUCT_KINDS,
  PRODUCT_KIND_LABELS,
  SUGGESTED_PRODUCT_CATEGORIES,
  normalizeBrand,
  normalizeSku,
  parsePriceInput,
  parseSpecsInput,
  type ProductBilling,
  type ProductKind,
} from "@/lib/products";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * Admin-only: add one product to the catalog.
 *
 * A plain PostgREST insert, not an Edge Function call. There is no file and
 * nothing privileged involved — the "admin inserts" policy is the whole
 * authorization story, and routing this through a function would add a
 * service-role hop to a write RLS already decides correctly. The same
 * reasoning that keeps MarketingMaterialAdminRow on PostgREST.
 *
 * One at a time, deliberately. A bulk-upload pipeline is a follow-up and needs
 * the real pricing sheet in hand: the column-mapping and blocker rules in
 * rep_payout_import_rows and user_import_rows were each read off an actual
 * file, and guessing them here would mean a parser to be rewritten.
 */
export function ProductCreateForm() {
  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [category, setCategory] = useState<string>(
    SUGGESTED_PRODUCT_CATEGORIES[0],
  );
  const [brand, setBrand] = useState("");
  // The column defaults match these, so a form submitted without touching
  // either writes what the database would have written anyway.
  const [kind, setKind] = useState<ProductKind>("device");
  const [billing, setBilling] = useState<ProductBilling>("one_time");
  const [price, setPrice] = useState("");
  const [description, setDescription] = useState("");
  const [specs, setSpecs] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const ready = name.trim() !== "" && category.trim() !== "";

  const create = async () => {
    setError(null);

    // Both parsed before anything is sent, so a bad price or a malformed specs
    // object is a sentence rather than a constraint violation from Postgres.
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
    const supabase = createClient();
    const { error: insertError } = await supabase.from("products").insert({
      name: name.trim(),
      // Normalised to null, never ''. idx_products_sku is partial on
      // `sku is not null`, so the empty string is a VALUE that index enforces
      // — two products cleared that way would collide on a uniqueness rule
      // neither admin meant to touch.
      sku: normalizeSku(sku),
      category: category.trim(),
      // Normalised to null for a related but different reason than sku's: a
      // blank brand collides with nothing, so it would simply render as an
      // empty heading in the rep's store. products_brand_not_blank is the
      // boundary; this is the courtesy that keeps it from being hit.
      brand: normalizeBrand(brand),
      kind,
      billing,
      list_price: parsedPrice.value,
      description: description.trim() === "" ? null : description.trim(),
      specs: parsedSpecs.value,
    });

    if (insertError) {
      setError(insertError.message);
      setBusy(false);
      return;
    }

    setName("");
    setSku("");
    setPrice("");
    setDescription("");
    setSpecs("");
    // brand, kind, billing and category deliberately KEEP their value. An
    // admin entering a lineup types six terminals from one vendor in a row,
    // and clearing these would mean re-typing the same four every time. The
    // per-product facts are cleared; the per-batch ones are not.
    setBusy(false);
    router.refresh();
  };

  return (
    <section className="flex flex-col gap-4 rounded-md border p-4">
      <h2 className="font-semibold">Add a product</h2>

      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-2">
          <Label htmlFor="product_name">Name</Label>
          <Input
            id="product_name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Clover Flex"
            className="w-64"
          />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="product_sku">Model / SKU</Label>
          <Input
            id="product_sku"
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            placeholder="C401U"
            className="w-40"
          />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="product_category">Category</Label>
          <Input
            id="product_category"
            list="product-category-suggestions"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-56"
          />
          {/* A datalist, not a select: category is free text in the schema on
              purpose, so a new kind of hardware does not need a migration.
              These are suggestions.

              Declared ONCE here, and every row below points its own category
              input at this same id. A second copy per row would be a duplicate
              element id, which is invalid HTML and makes the suggestions
              resolve unpredictably. The coupling is deliberate but invisible,
              so it is written down in both places: this form is always
              rendered on the page, so the list is always there for the rows. */}
          <datalist id="product-category-suggestions">
            {SUGGESTED_PRODUCT_CATEGORIES.map((item) => (
              <option key={item} value={item} />
            ))}
          </datalist>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="product_brand">Brand</Label>
          <Input
            id="product_brand"
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            placeholder="Clover"
            className="w-40"
          />
        </div>

        {/* A select, not a datalist, and that is the opposite call to
            Category right above it. Both columns look like free text and only
            one is: `kind` and `billing` carry two-value CHECKs because code
            reads them — the compatibility trigger, the store's device list,
            the proposal's two totals — so an invented value is a row all
            three silently skip, not a new label. The control should refuse
            what the column refuses. */}
        <div className="grid gap-2">
          <Label htmlFor="product_kind">Kind</Label>
          <select
            id="product_kind"
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

        <div className="grid gap-2">
          <Label htmlFor="product_billing">Billing</Label>
          <select
            id="product_billing"
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

        <div className="grid gap-2">
          <Label htmlFor="product_price">List price</Label>
          <Input
            id="product_price"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="499.00"
            inputMode="decimal"
            className="w-32"
          />
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        An <strong>add-on</strong> is only offered to a rep underneath a device
        it is linked to, so one with no links is invisible in the store. Links
        are set per add-on in the list below.
      </p>

      <div className="grid gap-2">
        <Label htmlFor="product_description">Description</Label>
        <Input
          id="product_description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Handheld terminal, 4G + wifi"
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="product_specs">Specs (JSON)</Label>
        <Textarea
          id="product_specs"
          value={specs}
          onChange={(e) => setSpecs(e.target.value)}
          placeholder={'{"connectivity": "wifi + 4g", "battery": "8h"}'}
          rows={3}
          className="font-mono text-xs"
        />
        {/* Said plainly because the column is deliberately loose and nothing
            validates the KEYS — a typo'd key is a fact about the product that
            no query will ever find. */}
        <p className="text-xs text-muted-foreground">
          Free-form, for whatever the lineup turns out to need. Keys are not
          checked or standardised yet, so keep them consistent by hand.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Button disabled={busy || !ready} onClick={() => void create()}>
          <PlusIcon size={16} />
          Add product
        </Button>
        <p className="text-xs text-muted-foreground">
          {ready
            ? "Leave the price blank if it is not set yet — blank means unpriced, not free, and an unpriced product cannot go on a quote."
            : "A name and a category are required."}
        </p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
    </section>
  );
}
