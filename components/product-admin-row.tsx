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
  type Product,
  formatSpecs,
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
export function ProductAdminRow({ product }: { product: Product }) {
  const [name, setName] = useState(product.name);
  const [sku, setSku] = useState(product.sku ?? "");
  const [category, setCategory] = useState(product.category);
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
      </div>

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
