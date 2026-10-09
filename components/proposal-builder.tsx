"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { PlusIcon, XIcon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { priceNumber, type Product } from "@/lib/products";
import {
  type CartDevice,
  cartProblem,
  cartToPayload,
  proposalHref,
} from "@/lib/quotes";
import { QuoteStore } from "@/components/quote-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/** Who a save is for. Chosen by the page around the builder, not by it. */
export type ProposalTarget = {
  /** null starts a new proposal; a group id adds a version to that group. */
  groupId: string | null;
  leadId: number | null;
  merchantId: number | null;
  /** Ignored by the database when linked — the trigger copies the record's. */
  customerName: string;
  /** The rep the proposal is FOR. An admin may choose any rep; a rep, only themselves. */
  agentId: string;
};

/**
 * The proposal builder: the store, the cart, a title and notes, and Save.
 *
 * Moved out of the old per-record QuotesPanel unchanged in substance — the
 * same QuoteStore, the same cart mutators, the same cartProblem() gate and
 * the same single create_quote_version() call. What changed is only where it
 * lives: /proposals/new and /proposals/[quoteGroupId].
 *
 * ## Append-only on edit
 *
 * Saving with a group id INSERTS a new version; nothing here can update an
 * existing one. That is not a UI convention — `authenticated` holds
 * `grant update (status)` and nothing else on `quotes`, and no UPDATE at all on
 * `quote_line_items`.
 *
 * ## A whole proposal is written by ONE call
 *
 * create_quote_version() is a security-invoker RPC rather than two supabase-js
 * inserts, because supabase-js has no client-side transaction: the alternative
 * leaves a window where the quote row exists and its lines do not.
 *
 * ## Prices leave here, and never arrive
 *
 * The cart sends product_id and quantity. Price, name, sku, billing and kind
 * are read off the catalog server-side, then re-derived by
 * snapshot_quote_line_item() at a layer no caller can skip. There is no price
 * field to hide: the RPC has no parameter for one.
 */
export function ProposalBuilder({
  target,
  targetProblem,
  initial,
  devices,
  addons,
  addonsByDevice,
  heading,
  onCancel,
}: {
  target: ProposalTarget;
  /** Why the target is not ready to save (no customer yet), or null. */
  targetProblem: string | null;
  initial: { title: string; notes: string; cart: CartDevice[] };
  devices: Product[];
  addons: Product[];
  addonsByDevice: Map<number, number[]>;
  heading: string;
  onCancel?: () => void;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(initial.title);
  const [notes, setNotes] = useState(initial.notes);
  const [cart, setCart] = useState<CartDevice[]>(initial.cart);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const productOf = useMemo(() => {
    const all = new Map<number, Product>();
    for (const product of [...devices, ...addons]) all.set(product.id, product);
    return all;
  }, [devices, addons]);

  /**
   * Which products the RPC would refuse. Only reachable through a revision:
   * the store offers nothing unpriced, but a revision is pre-filled from the
   * SNAPSHOT, so a product priced when the proposal was sent and unpriced now
   * comes back into the cart.
   */
  const unpriceable = (productId: number) => {
    const product = productOf.get(productId);
    return product === undefined || priceNumber(product.list_price) === null;
  };

  const addDevice = (productId: number) =>
    setCart((current) => {
      // Bump rather than add a second entry: two rows reading "Flex × 1" on a
      // document a merchant reads is a mistake, and a second entry would split
      // the add-ons chosen under it across two groups.
      const existing = current.find((device) => device.productId === productId);
      if (existing) {
        return current.map((device) =>
          device.productId === productId
            ? { ...device, quantity: device.quantity + 1 }
            : device,
        );
      }
      return [...current, { productId, quantity: 1, addons: [] }];
    });

  const deviceQuantity = (productId: number, quantity: number) =>
    setCart((current) =>
      current.map((device) =>
        device.productId === productId ? { ...device, quantity } : device,
      ),
    );

  // Takes its add-ons with it: an add-on only exists under the device it fits.
  const removeDevice = (productId: number) =>
    setCart((current) =>
      current.filter((device) => device.productId !== productId),
    );

  const addAddon = (deviceId: number, addonId: number) =>
    setCart((current) =>
      current.map((device) => {
        if (device.productId !== deviceId) return device;
        if (device.addons.some((a) => a.productId === addonId)) return device;
        return {
          ...device,
          addons: [...device.addons, { productId: addonId, quantity: 1 }],
        };
      }),
    );

  const addonQuantity = (deviceId: number, addonId: number, quantity: number) =>
    setCart((current) =>
      current.map((device) =>
        device.productId === deviceId
          ? {
              ...device,
              addons: device.addons.map((addon) =>
                addon.productId === addonId ? { ...addon, quantity } : addon,
              ),
            }
          : device,
      ),
    );

  const removeAddon = (deviceId: number, addonId: number) =>
    setCart((current) =>
      current.map((device) =>
        device.productId === deviceId
          ? {
              ...device,
              addons: device.addons.filter((a) => a.productId !== addonId),
            }
          : device,
      ),
    );

  const problem = targetProblem ?? cartProblem(cart, unpriceable);

  const save = async () => {
    if (problem !== null) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);

    const supabase = createClient();
    const { data: quoteId, error: rpcError } = await supabase.rpc(
      "create_quote_version",
      {
        lead_id_input: target.leadId,
        merchant_id_input: target.merchantId,
        customer_name_input: target.customerName,
        agent_id_input: target.agentId,
        quote_group_id_input: target.groupId,
        status_input: "draft",
        title_input: title,
        notes_input: notes,
        // product_id and quantity only, in device-then-add-ons order — that
        // order IS the grouping the printed sheet reads back.
        line_items_input: cartToPayload(cart),
      },
    );

    if (rpcError || typeof quoteId !== "number") {
      setError(rpcError?.message ?? "The proposal was not saved.");
      setBusy(false);
      return;
    }

    let groupId = target.groupId;
    if (groupId === null) {
      // A new proposal's group id is assigned by the column default, so read
      // it back — under RLS, as the row the caller just wrote.
      const { data } = await supabase
        .from("quotes")
        .select("quote_group_id")
        .eq("id", quoteId)
        .single();
      groupId = (data?.quote_group_id as string | undefined) ?? null;
    }

    if (groupId === null) {
      setError("Saved, but the proposal could not be reopened. Find it under Proposals.");
      setBusy(false);
      return;
    }

    if (target.groupId === null) {
      router.push(proposalHref(groupId));
    } else {
      setBusy(false);
      router.refresh();
      onCancel?.();
    }
  };

  return (
    <div
      className="flex flex-col gap-3 rounded-md border p-3 sm:p-4"
      data-testid="proposal-builder"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="min-w-0 font-medium">{heading}</h2>
        {onCancel && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
            <XIcon size={14} />
            Cancel
          </Button>
        )}
      </div>

      <div className="grid gap-1.5">
        <label className="text-xs text-muted-foreground" htmlFor="quote-title">
          Title
        </label>
        <Input
          id="quote-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Countertop package"
        />
      </div>

      <QuoteStore
        devices={devices}
        addons={addons}
        addonsByDevice={addonsByDevice}
        cart={cart}
        busy={busy}
        onAddDevice={addDevice}
        onDeviceQuantity={deviceQuantity}
        onRemoveDevice={removeDevice}
        onAddAddon={addAddon}
        onAddonQuantity={addonQuantity}
        onRemoveAddon={removeAddon}
      />

      <div className="grid gap-1.5">
        <label className="text-xs text-muted-foreground" htmlFor="quote-notes">
          Notes / terms
        </label>
        <Textarea
          id="quote-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
        />
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
        <Button disabled={busy || problem !== null} onClick={() => void save()}>
          <PlusIcon size={16} />
          {target.groupId === null ? "Save proposal" : "Save new version"}
        </Button>
      </div>

      {/* A target problem (no customer) is said even on an empty cart, since
          it is the first thing to fix; a cart problem only once there is a
          cart to have one. */}
      {targetProblem !== null ? (
        <p className="text-sm text-muted-foreground">{targetProblem}</p>
      ) : (
        problem !== null &&
        cart.length > 0 && <p className="text-sm text-destructive">{problem}</p>
      )}
      {error && error !== problem && (
        <p className="text-sm text-destructive">{error}</p>
      )}
    </div>
  );
}
