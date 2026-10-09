"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PlusIcon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { brandWriteError, normalizeBrandName } from "@/lib/brands";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * The last box on the brand grid: "Add brand", which opens in place into a
 * name field.
 *
 * On success it goes straight to the new brand's page, because the only thing
 * anyone does with an empty brand next is add its first product.
 */
export function BrandAddBox() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const normalized = normalizeBrandName(name);

  const create = async () => {
    if (normalized === null) return;
    setBusy(true);
    setError(null);
    const { data, error: insertError } = await createClient()
      .from("brands")
      .insert({ name: normalized })
      .select("id")
      .single();
    if (insertError || !data) {
      setBusy(false);
      setError(brandWriteError(insertError?.message ?? "Not created."));
      return;
    }
    router.push(`/admin/products/${data.id as number}`);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-full min-h-24 w-full flex-col items-center justify-center gap-1 rounded-md border border-dashed p-4 text-sm text-muted-foreground transition-colors hover:border-primary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <PlusIcon size={18} />
        Add brand
      </button>
    );
  }

  return (
    <form
      className="flex h-full min-h-24 flex-col gap-2 rounded-md border border-dashed p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <label htmlFor="new-brand-name" className="text-xs text-muted-foreground">
        Brand name
      </label>
      <Input
        id="new-brand-name"
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Material POS"
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-1.5">
        <Button type="submit" size="sm" disabled={busy || normalized === null}>
          {busy ? "Adding…" : "Add"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setName("");
            setError(null);
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
