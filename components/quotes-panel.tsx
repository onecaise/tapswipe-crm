"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  PencilIcon,
  PlusIcon,
  PrinterIcon,
  XIcon,
} from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { formatDateTime, formatMoney } from "@/lib/format";
import { priceNumber, type Product } from "@/lib/products";
import {
  QUOTE_STATUSES,
  QUOTE_STATUS_LABELS,
  type CartDevice,
  type Quote,
  type QuoteGroup,
  type QuoteLineItem,
  type QuoteOwnerType,
  cartFromLines,
  cartProblem,
  cartToPayload,
  groupQuoteLines,
  isQuoteStatus,
  lineTotals,
  quotePrintHref,
  statusIntent,
} from "@/lib/quotes";
import { QuoteStore } from "@/components/quote-store";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/**
 * The hardware-proposal builder and version history, on a LEAD or a MERCHANT.
 *
 * **Quotes are append-only on edit, and this panel has no in-place edit
 * affordance for anything but `status`.** Revising one opens the builder
 * pre-filled from the current version and SAVES A NEW VERSION; the old one
 * stays exactly as it was. That is not a UI convention a later change could
 * quietly undo — `authenticated` holds `grant update (status)` and nothing
 * else on `quotes`, and no UPDATE or DELETE at all on `quote_line_items`, so
 * an edit from here would come back "permission denied for column" rather
 * than reporting a save that rewrote history.
 *
 * ## One component for both owner kinds
 *
 * `ownerType` + `ownerId` arrive as props from a server page that has already
 * loaded that record under RLS, the same discipline NotesPanel follows — and
 * `ownerType` is a LITERAL at both call sites, never read from the URL. Here
 * the database would in fact catch a forged id (the insert policy carries an
 * `exists` on leads and another on merchants, precisely because both columns
 * are client-supplied), but the prop is still never taken from a searchParam,
 * because relying on the policy to catch it means the UI's correctness depends
 * on a clause somebody could decide looks redundant.
 *
 * Two real foreign keys rather than the polymorphic owner_type/owner_id that
 * notes and documents use — see the schema doc on quotes.lead_id. So this prop
 * pair is a UI convenience over two nullable columns, not a stored shape, and
 * `ownerColumn()` below is the one place it turns back into a column name.
 *
 * ## A whole proposal is written by ONE call
 *
 * `create_quote_version()` is a security-invoker RPC rather than two
 * supabase-js inserts, because supabase-js has no client-side transaction: the
 * alternative leaves a real window where the quote row exists and its lines do
 * not — a $0.00 proposal against a record, indistinguishable from one the rep
 * meant to send.
 *
 * ## Prices leave here, and never arrive
 *
 * The cart sends product_id and quantity. Price, name, sku, billing and kind
 * are read off the catalog server-side inside the transaction, then re-derived
 * by `snapshot_quote_line_item()` at a layer no caller can skip. So there is
 * no field to hide and nothing to validate: a rep cannot set a price because
 * there is no parameter for one.
 */
export function QuotesPanel({
  ownerType,
  ownerId,
  agentId,
  groups,
  linesByQuote,
  devices,
  addons,
  addonsByDevice,
}: {
  ownerType: QuoteOwnerType;
  ownerId: number;
  /**
   * The OWNING rep's id, not the viewer's.
   *
   * An admin building on a rep's behalf passes the REP's id — the proposal
   * must not move into the admin's book. Same call convert_ghost_sheet_to_lead
   * makes, and the reason documents and quotes carry no byline on the lead
   * timeline: `agent_id` on these tables is the owner, not the actor.
   */
  agentId: string;
  groups: QuoteGroup[];
  linesByQuote: Record<number, QuoteLineItem[]>;
  devices: Product[];
  addons: Product[];
  addonsByDevice: Map<number, number[]>;
}) {
  const router = useRouter();

  /** The open builder, or null when nothing is being drafted. */
  const [draft, setDraft] = useState<{
    /** null starts a new proposal; a group id adds a version to that group. */
    groupId: string | null;
    basedOnVersion: number | null;
    title: string;
    notes: string;
    cart: CartDevice[];
  } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const productOf = useMemo(() => {
    const all = new Map<number, Product>();
    for (const product of [...devices, ...addons]) all.set(product.id, product);
    return all;
  }, [devices, addons]);

  /**
   * Which products the RPC would refuse, for the Save button's message.
   *
   * Only reachable through a revision: the store offers nothing unpriced. A
   * revision is pre-filled from the SNAPSHOT, so a product priced when the
   * quote was sent and unpriced now comes back into the cart — and the save
   * would fail server-side with a message naming no line.
   */
  const unpriceable = (productId: number) => {
    const product = productOf.get(productId);
    return (
      product === undefined || priceNumber(product.list_price) === null
    );
  };

  const startNew = () => {
    setError(null);
    setDraft({
      groupId: null,
      basedOnVersion: null,
      title: "",
      notes: "",
      cart: [],
    });
  };

  /**
   * Opens the builder pre-filled from a proposal's current version.
   *
   * Through cartFromLines(), which reads the device/add-on nesting off
   * (sort_order, product_kind) — the one definition of that grouping, shared
   * with the printed document. A second spelling here is how a revision comes
   * to nest the add-ons differently from the sheet the rep is looking at.
   */
  const revise = (group: QuoteGroup) => {
    setError(null);
    setDraft({
      groupId: group.quoteGroupId,
      basedOnVersion: group.current.version,
      title: group.current.title ?? "",
      notes: group.current.notes ?? "",
      cart: cartFromLines(linesByQuote[group.current.id] ?? []),
    });
  };

  const mutateCart = (fn: (cart: CartDevice[]) => CartDevice[]) =>
    setDraft((d) => (d ? { ...d, cart: fn(d.cart) } : d));

  const addDevice = (productId: number) =>
    mutateCart((cart) => {
      // Bump the quantity rather than adding a second entry for the same
      // device: two rows reading "Flex × 1" on a document a merchant reads is
      // a mistake, not a choice. And a second entry would also split the
      // add-ons chosen under it across two groups.
      const existing = cart.find((device) => device.productId === productId);
      if (existing) {
        return cart.map((device) =>
          device.productId === productId
            ? { ...device, quantity: device.quantity + 1 }
            : device,
        );
      }
      return [...cart, { productId, quantity: 1, addons: [] }];
    });

  const deviceQuantity = (productId: number, quantity: number) =>
    mutateCart((cart) =>
      cart.map((device) =>
        device.productId === productId ? { ...device, quantity } : device,
      ),
    );

  const removeDevice = (productId: number) =>
    // Takes its add-ons with it, which is the nesting doing its job: an add-on
    // only exists in the context of the device it fits, so leaving one behind
    // would strand a line the store has no way to render.
    mutateCart((cart) => cart.filter((device) => device.productId !== productId));

  const addAddon = (deviceId: number, addonId: number) =>
    mutateCart((cart) =>
      cart.map((device) => {
        if (device.productId !== deviceId) return device;
        if (device.addons.some((a) => a.productId === addonId)) return device;
        return {
          ...device,
          addons: [...device.addons, { productId: addonId, quantity: 1 }],
        };
      }),
    );

  const addonQuantity = (
    deviceId: number,
    addonId: number,
    quantity: number,
  ) =>
    mutateCart((cart) =>
      cart.map((device) =>
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
    mutateCart((cart) =>
      cart.map((device) =>
        device.productId === deviceId
          ? {
              ...device,
              addons: device.addons.filter((a) => a.productId !== addonId),
            }
          : device,
      ),
    );

  const save = async () => {
    if (!draft) return;

    const problem = cartProblem(draft.cart, unpriceable);
    if (problem) {
      setError(problem);
      return;
    }

    setBusy(true);
    setError(null);

    const supabase = createClient();
    const { error: rpcError } = await supabase.rpc("create_quote_version", {
      // Exactly one of these is the record; the other is null, which is what
      // quotes_exactly_one_owner requires. Neither parameter has a default,
      // so this call has to say which.
      lead_id_input: ownerType === "lead" ? ownerId : null,
      merchant_id_input: ownerType === "merchant" ? ownerId : null,
      // Linked, so the trigger copies the record's name; nothing to type.
      customer_name_input: null,
      agent_id_input: agentId,
      quote_group_id_input: draft.groupId,
      status_input: "draft",
      title_input: draft.title,
      notes_input: draft.notes,
      // product_id and quantity only, in device-then-add-ons order — that
      // order IS the grouping the printed sheet reads back.
      line_items_input: cartToPayload(draft.cart),
    });

    if (rpcError) {
      setError(rpcError.message);
      setBusy(false);
      return;
    }

    setDraft(null);
    setBusy(false);
    router.refresh();
  };

  const setStatus = async (quote: Quote, status: string) => {
    setBusy(true);
    setError(null);

    const supabase = createClient();
    // The ONLY column `authenticated` may update on this table. An update
    // touching anything else fails with "permission denied for column".
    const { error: updateError } = await supabase
      .from("quotes")
      .update({ status })
      .eq("id", quote.id);

    if (updateError) {
      setError(updateError.message);
      setBusy(false);
      return;
    }

    setBusy(false);
    router.refresh();
  };

  const toggle = (groupId: string) => {
    setExpanded((open) => {
      const next = new Set(open);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-lg">Hardware proposals</h2>
        {draft === null && (
          <Button size="sm" onClick={startNew}>
            <PlusIcon size={16} />
            New proposal
          </Button>
        )}
      </div>

      {draft !== null && (
        <div className="flex flex-col gap-3 rounded-md border p-3 sm:p-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="min-w-0 font-medium">
              {draft.groupId === null
                ? "New proposal"
                : `Revising version ${draft.basedOnVersion} — saves as a new version`}
            </h3>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setDraft(null);
                setError(null);
              }}
            >
              <XIcon size={14} />
              Cancel
            </Button>
          </div>

          <div className="grid gap-1.5">
            <label
              className="text-xs text-muted-foreground"
              htmlFor="quote-title"
            >
              Title
            </label>
            <Input
              id="quote-title"
              value={draft.title}
              onChange={(e) =>
                setDraft((d) => (d ? { ...d, title: e.target.value } : d))
              }
              placeholder="Countertop package"
            />
          </div>

          <QuoteStore
            devices={devices}
            addons={addons}
            addonsByDevice={addonsByDevice}
            cart={draft.cart}
            busy={busy}
            onAddDevice={addDevice}
            onDeviceQuantity={deviceQuantity}
            onRemoveDevice={removeDevice}
            onAddAddon={addAddon}
            onAddonQuantity={addonQuantity}
            onRemoveAddon={removeAddon}
          />

          <div className="grid gap-1.5">
            <label
              className="text-xs text-muted-foreground"
              htmlFor="quote-notes"
            >
              Notes / terms
            </label>
            <Textarea
              id="quote-notes"
              value={draft.notes}
              onChange={(e) =>
                setDraft((d) => (d ? { ...d, notes: e.target.value } : d))
              }
              rows={2}
            />
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
            <Button
              disabled={busy || cartProblem(draft.cart, unpriceable) !== null}
              onClick={() => void save()}
            >
              <PlusIcon size={16} />
              {draft.groupId === null ? "Save proposal" : "Save new version"}
            </Button>
          </div>

          {cartProblem(draft.cart, unpriceable) !== null &&
            draft.cart.length > 0 && (
              <p className="text-sm text-destructive">
                {cartProblem(draft.cart, unpriceable)}
              </p>
            )}
        </div>
      )}

      {groups.length === 0 && draft === null ? (
        <p className="text-sm text-muted-foreground">
          No proposals on this {ownerType === "lead" ? "lead" : "merchant"} yet.
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {groups.map((group) => {
            const lines = linesByQuote[group.current.id] ?? [];
            const totals = lineTotals(lines);
            const isOpen = expanded.has(group.quoteGroupId);
            return (
              <li key={group.quoteGroupId} className="flex flex-col gap-2 p-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">
                        {group.current.title ?? "Untitled proposal"}
                      </span>
                      <StatusBadge intent={statusIntent(group.current.status)}>
                        {isQuoteStatus(group.current.status)
                          ? QUOTE_STATUS_LABELS[group.current.status]
                          : group.current.status}
                      </StatusBadge>
                      {/* The version number is always shown, even at v1.
                          "Version 1 of 1" is what tells a rep this is a record
                          with a history at all, which is the thing they have
                          to know before they click Revise. */}
                      <span className="text-xs text-muted-foreground">
                        Version {group.current.version} of{" "}
                        {group.versions.length}
                      </span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {formatDateTime(group.current.created_at)}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {/* Two figures, never summed — see lineTotals(). */}
                    <span className="text-sm tabular-nums">
                      <span className="font-medium">
                        {formatMoney(totals.oneTime)}
                      </span>
                      <span className="text-muted-foreground"> one-time</span>
                      {totals.monthly > 0 && (
                        <>
                          {" · "}
                          <span className="font-medium">
                            {formatMoney(totals.monthly)}
                          </span>
                          <span className="text-muted-foreground">/mo</span>
                        </>
                      )}
                    </span>
                    {/* No ?quote= — the bare group URL prints whatever is
                        current, which is what this row is showing. A link
                        pinned to today's row id would keep printing this
                        version after the next revision. */}
                    <Button asChild size="sm" variant="outline">
                      <Link
                        href={quotePrintHref(
                          ownerType,
                          ownerId,
                          group.quoteGroupId,
                        )}
                      >
                        <PrinterIcon size={14} />
                        Print
                      </Link>
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || draft !== null}
                      onClick={() => revise(group)}
                    >
                      <PencilIcon size={14} />
                      Revise
                    </Button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <select
                    className="h-8 rounded-md border bg-background px-2 text-xs"
                    value={group.current.status}
                    disabled={busy}
                    aria-label={`Status of ${group.current.title ?? "proposal"}`}
                    onChange={(e) =>
                      void setStatus(group.current, e.target.value)
                    }
                  >
                    {QUOTE_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {QUOTE_STATUS_LABELS[status]}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
                    onClick={() => toggle(group.quoteGroupId)}
                  >
                    {isOpen ? (
                      <ChevronDownIcon size={14} />
                    ) : (
                      <ChevronRightIcon size={14} />
                    )}
                    {isOpen ? "Hide" : "Lines and history"}
                  </button>
                </div>

                {isOpen && (
                  <div className="flex flex-col gap-3">
                    <QuoteLines lines={lines} />

                    <ol className="flex flex-col gap-1.5 border-t pt-2">
                      {group.versions.map((version) => (
                        <li
                          key={version.id}
                          className="flex flex-col gap-0.5 text-xs"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">
                              Version {version.version}
                            </span>
                            <span className="text-muted-foreground">
                              {formatDateTime(version.created_at)}
                            </span>
                            <Link
                              className="text-primary hover:underline"
                              href={quotePrintHref(
                                ownerType,
                                ownerId,
                                group.quoteGroupId,
                                version.id,
                              )}
                            >
                              Print this version
                            </Link>
                          </div>
                          {version.notes && (
                            <p className="text-muted-foreground">
                              {version.notes}
                            </p>
                          )}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}

                {group.current.notes && (
                  <p className="text-xs text-muted-foreground">
                    {group.current.notes}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <p className="text-xs text-muted-foreground">
        Proposals are never edited in place. Revising one saves a new version
        and leaves the old one exactly as it was, with the prices it was sent at
        — so a merchant disputing what they were offered can be answered from
        the record.
      </p>
    </section>
  );
}

/** The saved lines of one version, grouped device-then-add-ons. */
function QuoteLines({ lines }: { lines: QuoteLineItem[] }) {
  if (lines.length === 0) {
    // create_quote_version() refuses a quote with no lines, so this is
    // unreachable through the app. Rendered rather than omitted because the
    // alternative — a proposal that silently shows nothing — is exactly the
    // state the RPC exists to make impossible, and it should be legible if it
    // ever appears.
    return (
      <p className="text-xs text-muted-foreground">No line items recorded.</p>
    );
  }

  // The same grouping the printed sheet uses, from the same function: read off
  // (sort_order, product_kind) rather than from a live join against
  // product_compatibility, so a saved proposal does not re-group itself when
  // an admin unlinks an accessory.
  const groups = groupQuoteLines(lines);

  return (
    <ul className="flex flex-col gap-1.5 text-sm">
      {groups.map((group, index) => (
        <li
          key={group.device?.id ?? `orphans-${index}`}
          className="flex flex-col gap-0.5"
        >
          {group.device !== null && <LineRow line={group.device} />}
          {group.addons.length > 0 && (
            <ul className="flex flex-col gap-0.5 border-l pl-3">
              {group.addons.map((addon) => (
                <li key={addon.id}>
                  <LineRow line={addon} />
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

function LineRow({ line }: { line: QuoteLineItem }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="tabular-nums text-muted-foreground">
        {line.quantity}×
      </span>
      <span className="min-w-0 truncate">{line.product_name}</span>
      {line.product_sku && (
        <span className="shrink-0 text-xs text-muted-foreground">
          {line.product_sku}
        </span>
      )}
      {line.product_billing === "monthly" && (
        <span className="shrink-0 text-xs text-muted-foreground">/mo</span>
      )}
      <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
        {formatMoney(line.unit_price)}
      </span>
      <span className="w-24 shrink-0 text-right tabular-nums">
        {formatMoney(line.line_total)}
      </span>
    </div>
  );
}
