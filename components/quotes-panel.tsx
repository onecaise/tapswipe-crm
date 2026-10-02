"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { formatDateTime, formatMoney } from "@/lib/format";
import { priceNumber, type Product } from "@/lib/products";
import {
  QUOTE_STATUSES,
  QUOTE_STATUS_LABELS,
  type DraftLine,
  type Quote,
  type QuoteGroup,
  type QuoteLineItem,
  draftProblem,
  draftTotal,
  isQuoteStatus,
  lineItemsPayload,
  quoteTotal,
  statusIntent,
} from "@/lib/quotes";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/**
 * The quote builder and version history on a lead.
 *
 * **Quotes are append-only on edit, and this panel has no in-place edit
 * affordance for anything but `status`.** Revising a quote opens the builder
 * pre-filled from the current version and SAVES A NEW VERSION; the old one
 * stays exactly as it was. That is not a UI convention a later change could
 * quietly undo — `authenticated` holds `grant update (status)` and nothing
 * else on `quotes`, and no UPDATE or DELETE at all on `quote_line_items`, so
 * an edit from here would come back "permission denied for column" rather
 * than reporting a save that rewrote history.
 *
 * `leadId` and `agentId` arrive as props from a server page that has already
 * loaded that lead under RLS, the same discipline NotesPanel follows. Here the
 * database would in fact catch a forged lead_id — the insert policy carries an
 * `exists` on leads precisely because lead_id is client-supplied — but the
 * prop is still never read from the URL, because relying on the policy to
 * catch it means the UI's correctness depends on a clause somebody could
 * decide looks redundant.
 *
 * A whole quote is written by ONE call to create_quote_version(), which is a
 * security-invoker RPC rather than two supabase-js inserts. supabase-js has no
 * client-side transaction, so the alternative leaves a real window where the
 * quote row exists and its lines do not — a $0.00 quote against a lead,
 * indistinguishable from one the rep meant to send.
 */
export function QuotesPanel({
  leadId,
  agentId,
  groups,
  linesByQuote,
  products,
}: {
  leadId: number;
  agentId: string;
  groups: QuoteGroup[];
  linesByQuote: Record<number, QuoteLineItem[]>;
  products: Product[];
}) {
  const router = useRouter();

  /** The open builder, or null when nothing is being drafted. */
  const [draft, setDraft] = useState<{
    /** null starts a new quote; a group id adds a version to that group. */
    groupId: string | null;
    basedOnVersion: number | null;
    title: string;
    notes: string;
    lines: DraftLine[];
  } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const priceOf = useMemo(() => {
    const prices = new Map(
      products.map((p) => [p.id, priceNumber(p.list_price)]),
    );
    return (productId: number) => prices.get(productId) ?? null;
  }, [products]);

  const productOf = useMemo(
    () => new Map(products.map((p) => [p.id, p])),
    [products],
  );

  const startNew = () => {
    setError(null);
    setDraft({
      groupId: null,
      basedOnVersion: null,
      title: "",
      notes: "",
      lines: [],
    });
  };

  /**
   * Opens the builder pre-filled from a quote's current version.
   *
   * Pre-filled from the SAVED LINE ITEMS rather than from the catalog, so a
   * revision starts from what the merchant was actually shown. The quantities
   * carry across; the prices do not, because create_quote_version() re-reads
   * them server-side — a revision therefore picks up the current list price,
   * which is what revising a quote means.
   */
  const revise = (group: QuoteGroup) => {
    setError(null);
    const lines = linesByQuote[group.current.id] ?? [];
    setDraft({
      groupId: group.quoteGroupId,
      basedOnVersion: group.current.version,
      title: group.current.title ?? "",
      notes: group.current.notes ?? "",
      lines: lines.map((line) => ({
        productId: line.product_id,
        quantity: line.quantity,
      })),
    });
  };

  const addLine = (productId: number) => {
    setDraft((d) => {
      if (!d) return d;
      // Bump the quantity rather than adding a second line for the same
      // product: two lines reading "Clover Flex × 1" on a document a merchant
      // reads is a mistake, not a choice.
      const existing = d.lines.find((line) => line.productId === productId);
      if (existing) {
        return {
          ...d,
          lines: d.lines.map((line) =>
            line.productId === productId
              ? { ...line, quantity: line.quantity + 1 }
              : line,
          ),
        };
      }
      return { ...d, lines: [...d.lines, { productId, quantity: 1 }] };
    });
  };

  const setQuantity = (productId: number, quantity: number) => {
    setDraft((d) =>
      d
        ? {
            ...d,
            lines: d.lines.map((line) =>
              line.productId === productId ? { ...line, quantity } : line,
            ),
          }
        : d,
    );
  };

  const removeLine = (productId: number) => {
    setDraft((d) =>
      d
        ? { ...d, lines: d.lines.filter((line) => line.productId !== productId) }
        : d,
    );
  };

  const save = async () => {
    if (!draft) return;

    const problem = draftProblem(draft.lines);
    if (problem) {
      setError(problem);
      return;
    }

    setBusy(true);
    setError(null);

    const supabase = createClient();
    const { error: rpcError } = await supabase.rpc("create_quote_version", {
      lead_id_input: leadId,
      // The rep's own id, which the insert policy's `with check` requires. An
      // admin building on a rep's behalf passes the REP's id — the quote must
      // not move into the admin's book, which is the call
      // convert_ghost_sheet_to_lead makes for the same reason.
      agent_id_input: agentId,
      quote_group_id_input: draft.groupId,
      status_input: "draft",
      title_input: draft.title,
      notes_input: draft.notes,
      // product_id and quantity only. Price, name and sku are snapshotted
      // server-side inside the same transaction.
      line_items_input: lineItemsPayload(draft.lines),
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
        <h2 className="font-semibold text-lg">Quotes</h2>
        {draft === null && (
          <Button size="sm" onClick={startNew}>
            <PlusIcon size={16} />
            New quote
          </Button>
        )}
      </div>

      {draft !== null && (
        <QuoteBuilder
          draft={draft}
          products={products}
          productOf={productOf}
          priceOf={priceOf}
          busy={busy}
          onTitle={(title) => setDraft((d) => (d ? { ...d, title } : d))}
          onNotes={(notes) => setDraft((d) => (d ? { ...d, notes } : d))}
          onAdd={addLine}
          onQuantity={setQuantity}
          onRemove={removeLine}
          onCancel={() => {
            setDraft(null);
            setError(null);
          }}
          onSave={() => void save()}
        />
      )}

      {groups.length === 0 && draft === null ? (
        <p className="text-sm text-muted-foreground">
          No quotes on this lead yet.
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {groups.map((group) => {
            const lines = linesByQuote[group.current.id] ?? [];
            const isOpen = expanded.has(group.quoteGroupId);
            return (
              <li
                key={group.quoteGroupId}
                className="flex flex-col gap-2 p-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">
                        {group.current.title ?? "Untitled quote"}
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

                  <div className="flex items-center gap-2">
                    <span className="font-medium">
                      {formatMoney(quoteTotal(lines))}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => revise(group)}
                    >
                      <PencilIcon size={14} />
                      Revise
                    </Button>
                  </div>
                </div>

                <QuoteLines lines={lines} />

                <div className="flex flex-wrap items-center gap-2">
                  <label
                    className="text-xs text-muted-foreground"
                    htmlFor={`quote-status-${group.current.id}`}
                  >
                    Status
                  </label>
                  {/* The one mutable column, and a plain select because
                      moving a quote to "sent" is not a destructive act and
                      needs no confirmation step. A superseded version keeps
                      whatever status it had, which is why only the current
                      one is editable here. */}
                  <select
                    id={`quote-status-${group.current.id}`}
                    className="h-8 rounded-md border bg-background px-2 text-sm"
                    value={group.current.status}
                    disabled={busy}
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

                  {group.versions.length > 1 && (
                    <button
                      type="button"
                      className="ml-auto flex items-center gap-1 text-xs underline underline-offset-2"
                      onClick={() => toggle(group.quoteGroupId)}
                    >
                      {isOpen ? (
                        <ChevronDownIcon size={14} />
                      ) : (
                        <ChevronRightIcon size={14} />
                      )}
                      {isOpen
                        ? "Hide earlier versions"
                        : `${group.versions.length - 1} earlier version${
                            group.versions.length === 2 ? "" : "s"
                          }`}
                    </button>
                  )}
                </div>

                {/* The history. Every superseded version renders in full,
                    with ITS OWN snapshotted prices — which is the whole point
                    of the design: what the merchant was shown in March does
                    not change because the catalog did in April. */}
                {isOpen && (
                  <ol className="flex flex-col gap-3 border-l pl-3">
                    {group.versions.slice(1).map((version) => (
                      <li key={version.id} className="flex flex-col gap-1">
                        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">
                            Version {version.version}
                          </span>
                          <StatusBadge intent={statusIntent(version.status)}>
                            {isQuoteStatus(version.status)
                              ? QUOTE_STATUS_LABELS[version.status]
                              : version.status}
                          </StatusBadge>
                          <span>{formatDateTime(version.created_at)}</span>
                          <span>·</span>
                          <span>
                            {formatMoney(
                              quoteTotal(linesByQuote[version.id] ?? []),
                            )}
                          </span>
                        </div>
                        <QuoteLines lines={linesByQuote[version.id] ?? []} />
                        {version.notes && (
                          <p className="text-xs text-muted-foreground">
                            {version.notes}
                          </p>
                        )}
                      </li>
                    ))}
                  </ol>
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
        Quotes are never edited in place. Revising one saves a new version and
        leaves the old one exactly as it was, with the prices it was sent at —
        so a merchant disputing what they were offered can be answered from the
        record.
      </p>
    </section>
  );
}

/** The saved lines of one version, read-only. */
function QuoteLines({ lines }: { lines: QuoteLineItem[] }) {
  if (lines.length === 0) {
    // create_quote_version() refuses a quote with no lines, so this is
    // unreachable through the app. Rendered rather than omitted because the
    // alternative — a quote that silently shows nothing — is exactly the state
    // the RPC exists to make impossible, and it should be legible if it ever
    // appears.
    return (
      <p className="text-xs text-muted-foreground">No line items recorded.</p>
    );
  }

  return (
    <ul className="flex flex-col gap-0.5 text-sm">
      {lines.map((line) => (
        <li key={line.id} className="flex items-baseline gap-2">
          <span className="text-muted-foreground tabular-nums">
            {line.quantity}×
          </span>
          <span>{line.product_name}</span>
          {line.product_sku && (
            <span className="text-xs text-muted-foreground">
              {line.product_sku}
            </span>
          )}
          <span className="ml-auto tabular-nums text-muted-foreground">
            {formatMoney(line.unit_price)}
          </span>
          <span className="w-24 text-right tabular-nums">
            {formatMoney(line.line_total)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The draft builder: pick from the catalog, set quantities, see the total. */
function QuoteBuilder({
  draft,
  products,
  productOf,
  priceOf,
  busy,
  onTitle,
  onNotes,
  onAdd,
  onQuantity,
  onRemove,
  onCancel,
  onSave,
}: {
  draft: {
    groupId: string | null;
    basedOnVersion: number | null;
    title: string;
    notes: string;
    lines: DraftLine[];
  };
  products: Product[];
  productOf: Map<number, Product>;
  priceOf: (productId: number) => number | null;
  busy: boolean;
  onTitle: (value: string) => void;
  onNotes: (value: string) => void;
  onAdd: (productId: number) => void;
  onQuantity: (productId: number, quantity: number) => void;
  onRemove: (productId: number) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const problem = draftProblem(draft.lines);
  const total = draftTotal(draft.lines, priceOf);

  return (
    <div className="flex flex-col gap-3 rounded-md border p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">
          {draft.groupId === null
            ? "New quote"
            : `Revising version ${draft.basedOnVersion} — saves as a new version`}
        </h3>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          <XIcon size={14} />
          Cancel
        </Button>
      </div>

      <div className="grid gap-2">
        <label className="text-xs text-muted-foreground" htmlFor="quote-title">
          Title
        </label>
        <Input
          id="quote-title"
          value={draft.title}
          onChange={(e) => onTitle(e.target.value)}
          placeholder="Countertop package"
        />
      </div>

      <div className="grid gap-2">
        <label
          className="text-xs text-muted-foreground"
          htmlFor="quote-product"
        >
          Add from the catalog
        </label>
        {products.length === 0 ? (
          // The catalog is deliberately empty until the real pricing sheet
          // arrives, so this is the expected state rather than an error — and
          // it has to say where the fix lives, since a rep cannot add a
          // product themselves.
          <p className="text-sm text-muted-foreground">
            Nothing in the catalog can be quoted yet. An admin adds products,
            with a list price, under Products.
          </p>
        ) : (
          <select
            id="quote-product"
            className="h-9 rounded-md border bg-background px-2 text-sm"
            value=""
            disabled={busy}
            onChange={(e) => {
              const id = Number(e.target.value);
              if (Number.isInteger(id) && id > 0) onAdd(id);
            }}
          >
            <option value="">Pick a product…</option>
            {products.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name}
                {product.sku ? ` (${product.sku})` : ""} —{" "}
                {formatMoney(priceNumber(product.list_price))}
              </option>
            ))}
          </select>
        )}
      </div>

      {draft.lines.length > 0 && (
        <ul className="flex flex-col gap-2">
          {draft.lines.map((line) => {
            const product = productOf.get(line.productId);
            const price = priceOf(line.productId);
            return (
              <li key={line.productId} className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  step={1}
                  value={line.quantity}
                  disabled={busy}
                  onChange={(e) =>
                    onQuantity(line.productId, Number(e.target.value))
                  }
                  className="w-20"
                  aria-label={`Quantity of ${product?.name ?? "product"}`}
                />
                <span className="text-sm">{product?.name ?? "—"}</span>
                <span className="ml-auto text-sm tabular-nums text-muted-foreground">
                  {formatMoney(price)}
                </span>
                <span className="w-24 text-right text-sm tabular-nums">
                  {formatMoney(price === null ? null : price * line.quantity)}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => onRemove(line.productId)}
                  aria-label={`Remove ${product?.name ?? "line"}`}
                >
                  <Trash2Icon size={14} />
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="grid gap-2">
        <label className="text-xs text-muted-foreground" htmlFor="quote-notes">
          Notes / terms
        </label>
        <Textarea
          id="quote-notes"
          value={draft.notes}
          onChange={(e) => onNotes(e.target.value)}
          rows={2}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm">
          Total <span className="font-medium">{formatMoney(total)}</span>
          {/* Said out loud, because it is the one place the preview can
              disagree with what gets saved: the server re-reads the catalog
              inside the transaction, so an admin repricing between these two
              moments wins. */}
          <span className="ml-2 text-xs text-muted-foreground">
            Prices are taken from the catalog when the quote is saved.
          </span>
        </span>
        <Button disabled={busy || problem !== null} onClick={onSave}>
          <PlusIcon size={16} />
          {draft.groupId === null ? "Save quote" : "Save new version"}
        </Button>
      </div>

      {problem !== null && draft.lines.length > 0 && (
        <p className="text-sm text-destructive">{problem}</p>
      )}
    </div>
  );
}
