"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PencilIcon, Trash2Icon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { type Brand, brandWriteError, normalizeBrandName } from "@/lib/brands";
import { ConfirmPair } from "@/components/confirm-pair";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Rename and delete, on a brand's own page.
 *
 * RENAME CASCADES in the database (products.brand is an FK with ON UPDATE
 * CASCADE), so this is one UPDATE on brands and every product follows. The
 * page's URL is the brand's id, so it survives the rename and a refresh is
 * enough.
 *
 * DELETE is only OFFERED for an empty brand, and only REFUSED by the database:
 * ON DELETE RESTRICT on that FK is the boundary, archived products included.
 * The hidden button is a courtesy; a stale page that still shows it gets the
 * FK's refusal, translated.
 */
export function BrandSettings({
  brand,
  productCount,
}: {
  brand: Brand;
  productCount: number;
}) {
  const [mode, setMode] = useState<"idle" | "rename" | "delete">("idle");
  const [name, setName] = useState(brand.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const normalized = normalizeBrandName(name);

  const rename = async () => {
    if (normalized === null || normalized === brand.name) {
      setMode("idle");
      return;
    }
    setBusy(true);
    setError(null);
    const { error: updateError } = await createClient()
      .from("brands")
      .update({ name: normalized })
      .eq("id", brand.id);
    setBusy(false);
    if (updateError) {
      setError(brandWriteError(updateError.message));
      return;
    }
    setMode("idle");
    router.refresh();
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    // .select() so a delete RLS filtered to nothing is distinguishable from
    // one that happened — a filtered DELETE reports success.
    const { data, error: deleteError } = await createClient()
      .from("brands")
      .delete()
      .eq("id", brand.id)
      .select("id");
    if (deleteError || !data || data.length === 0) {
      setBusy(false);
      setMode("idle");
      setError(
        brandWriteError(deleteError?.message ?? "The brand was not deleted."),
      );
      return;
    }
    router.push("/admin/products");
  };

  return (
    <div className="flex flex-col gap-2">
      {mode === "rename" ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void rename();
          }}
        >
          <label htmlFor="brand-rename" className="sr-only">
            Brand name
          </label>
          <Input
            id="brand-rename"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-56 max-w-full"
          />
          <Button type="submit" size="sm" disabled={busy || normalized === null}>
            {busy ? "Saving…" : "Save name"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setMode("idle");
              setName(brand.name);
            }}
          >
            Cancel
          </Button>
        </form>
      ) : mode === "delete" ? (
        <ConfirmPair
          label={`Delete ${brand.name}?`}
          confirmLabel="Delete"
          destructive
          busy={busy}
          onConfirm={() => void remove()}
          onCancel={() => setMode("idle")}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setMode("rename")}>
            <PencilIcon size={14} />
            Rename
          </Button>
          {productCount === 0 && (
            <Button size="sm" variant="outline" onClick={() => setMode("delete")}>
              <Trash2Icon size={14} />
              Delete brand
            </Button>
          )}
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
