"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArchiveIcon, ArchiveRestoreIcon, PencilIcon, PlusIcon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import type { Brand } from "@/lib/brands";
import { formatMoney } from "@/lib/format";
import {
  PRODUCT_KIND_LABELS,
  type Product,
  isProductKind,
  priceNumber,
} from "@/lib/products";
import type { DeviceOption } from "@/components/device-multi-select";
import { ProductForm } from "@/components/product-form";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type Shared = {
  brands: readonly Brand[];
  categorySuggestions: readonly string[];
  deviceOptions: readonly DeviceOption[];
  deviceNames: Readonly<Record<number, string>>;
};

/**
 * A brand's products as a compact list — one line each — with the add form
 * behind a button and each row's edit form behind its own.
 *
 * At most ONE form is open at a time. Two open forms on one page is two sets
 * of unsaved state an admin has to remember, and a save in one router.refresh()es
 * the other's props out from under it.
 */
export function BrandProducts({
  brandName,
  products,
  fitsByAddon,
  ...shared
}: Shared & {
  /** The brand new products are filed under; null on the unbranded page. */
  brandName: string | null;
  /** Already in page order: devices first, then add-ons. */
  products: readonly Product[];
  fitsByAddon: Readonly<Record<number, number[]>>;
}) {
  // "new", a product id, or null.
  const [open, setOpen] = useState<"new" | number | null>(null);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Products</h2>
        {open !== "new" && (
          <Button size="sm" onClick={() => setOpen("new")}>
            <PlusIcon size={16} />
            Add product
          </Button>
        )}
      </div>

      {open === "new" && (
        <div className="rounded-md border bg-card p-4">
          <h3 className="mb-3 text-sm font-semibold">New product</h3>
          <ProductForm
            product={null}
            brand={brandName}
            fitsDeviceIds={[]}
            onDone={() => setOpen(null)}
            onCancel={() => setOpen(null)}
            {...shared}
          />
        </div>
      )}

      {products.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No products in this brand yet.
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border bg-card">
          {products.map((product) => (
            <BrandProductRow
              key={product.id}
              product={product}
              fitsDeviceIds={fitsByAddon[product.id] ?? []}
              editing={open === product.id}
              onEdit={() => setOpen(product.id)}
              onClose={() => setOpen(null)}
              {...shared}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function BrandProductRow({
  product,
  fitsDeviceIds,
  editing,
  onEdit,
  onClose,
  ...shared
}: Shared & {
  product: Product;
  fitsDeviceIds: number[];
  editing: boolean;
  onEdit: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const isArchived = product.archived_at !== null;
  const price = priceNumber(product.list_price);
  const kindLabel = isProductKind(product.kind)
    ? PRODUCT_KIND_LABELS[product.kind]
    : product.kind;

  /**
   * Archive or restore. Outline, never destructive red: archiving is
   * reversible and takes nothing away, and there is nothing irreversible on
   * products by design — no DELETE policy, no DELETE grant.
   */
  const setArchived = async (archived: boolean) => {
    setBusy(true);
    setError(null);
    const { error: updateError } = await createClient()
      .from("products")
      .update({ archived_at: archived ? new Date().toISOString() : null })
      .eq("id", product.id);
    setBusy(false);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    router.refresh();
  };

  return (
    <li
      className="flex flex-col gap-3 px-3 py-2.5"
      data-testid={`product-row-${product.id}`}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 flex-col">
          <span
            className={
              "truncate text-sm font-medium" +
              (isArchived ? " text-muted-foreground" : "")
            }
          >
            {product.name}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {product.category}
            {product.sku ? ` · ${product.sku}` : ""}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm tabular-nums">
            {price === null ? "—" : formatMoney(price)}
            {product.billing === "monthly" && price !== null ? "/mo" : ""}
          </span>
          <Badge variant="outline">{kindLabel}</Badge>
          {isArchived ? (
            <StatusBadge intent="neutral">Archived</StatusBadge>
          ) : (
            <StatusBadge intent="success">Active</StatusBadge>
          )}
          {/* create_quote_version() refuses an unpriced product rather than
              pricing it at zero; the fix is an admin typing a number. */}
          {price === null && !isArchived && (
            <StatusBadge intent="warning">No price</StatusBadge>
          )}
          {product.kind === "addon" &&
            fitsDeviceIds.length === 0 &&
            !isArchived && (
              <StatusBadge intent="warning">Fits nothing</StatusBadge>
            )}

          <div className="ml-auto flex items-center gap-1 sm:ml-2">
            {!editing && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={onEdit}
                aria-label={`Edit ${product.name}`}
              >
                <PencilIcon size={14} />
                Edit
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void setArchived(!isArchived)}
              aria-label={`${isArchived ? "Restore" : "Archive"} ${product.name}`}
            >
              {isArchived ? (
                <ArchiveRestoreIcon size={14} />
              ) : (
                <ArchiveIcon size={14} />
              )}
              {isArchived ? "Restore" : "Archive"}
            </Button>
          </div>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {editing && (
        <div className="rounded-md border bg-background p-3">
          <ProductForm
            product={product}
            brand={product.brand}
            fitsDeviceIds={fitsDeviceIds}
            onDone={onClose}
            onCancel={onClose}
            {...shared}
          />
        </div>
      )}
    </li>
  );
}
