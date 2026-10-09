"use client";

import { useEffect, useId, useState } from "react";
import { XIcon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import type { Product } from "@/lib/products";
import type { QuoteOwnerType } from "@/lib/quotes";
import { ProposalBuilder } from "@/components/proposal-builder";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type ProposalLink = {
  type: QuoteOwnerType;
  id: number;
  name: string;
};

type SearchHit = {
  kind: string;
  record_id: number;
  title: string | null;
  subtitle: string | null;
};

const MIN_SEARCH_LENGTH = 2;

/**
 * /proposals/new: who the proposal is for, then the builder.
 *
 * ## The customer: a record, or a typed name
 *
 * Search runs through `search_crm()`, the same security-INVOKER function the
 * top bar uses — so a rep can only ever find, and therefore only ever link,
 * records their own policies show them. The insert policy checks the link
 * again ("a record the caller can see"); this is the courtesy, that is the
 * boundary. Only leads and merchants are offered: a proposal links to nothing
 * else.
 *
 * A typed name is for a business that is not in the CRM yet. It is required
 * (the RPC and quotes_customer_name_not_blank both refuse a blank one).
 *
 * ## The rep: admins choose, reps do not
 *
 * A rep's proposals are always their own — the insert policy refuses anything
 * else — so a rep is shown no control at all. An admin picks the rep it is for.
 */
export function NewProposal({
  viewerId,
  reps,
  prefill,
  devices,
  addons,
  addonsByDevice,
}: {
  viewerId: string;
  /** Admins only: every rep a proposal may be made for. null for a rep. */
  reps: { id: string; name: string }[] | null;
  /** From ?lead= / ?merchant=, already loaded under the caller's RLS. */
  prefill: (ProposalLink & { agentId: string }) | null;
  devices: Product[];
  addons: Product[];
  addonsByDevice: Map<number, number[]>;
}) {
  const ids = useId();
  const [mode, setMode] = useState<"record" | "typed">("record");
  const [link, setLink] = useState<ProposalLink | null>(
    prefill === null ? null : { type: prefill.type, id: prefill.id, name: prefill.name },
  );
  const [typedName, setTypedName] = useState("");
  const [repId, setRepId] = useState<string>(
    reps === null ? viewerId : (prefill?.agentId ?? ""),
  );

  const customerProblem =
    mode === "record"
      ? link === null
        ? "Choose the lead or merchant this proposal is for, or type a customer name."
        : null
      : typedName.trim() === ""
        ? "Type the customer's name."
        : null;
  const repProblem =
    repId === "" ? "Choose the rep this proposal is for." : null;

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3 rounded-md border p-3 sm:p-4">
        <h2 className="font-medium">Customer</h2>

        <fieldset className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <legend className="sr-only">Who is this proposal for?</legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name={`${ids}-mode`}
              checked={mode === "record"}
              onChange={() => setMode("record")}
            />
            A lead or merchant in the CRM
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name={`${ids}-mode`}
              checked={mode === "typed"}
              onChange={() => setMode("typed")}
            />
            Not in the CRM — type a name
          </label>
        </fieldset>

        {mode === "record" ? (
          link !== null ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">
                {link.type === "lead" ? "Lead" : "Merchant"}:
              </span>
              <span className="font-medium" data-testid="chosen-customer">
                {link.name}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setLink(null)}
                aria-label="Change customer"
              >
                <XIcon size={14} />
                Change
              </Button>
            </div>
          ) : (
            <RecordSearch inputId={`${ids}-search`} onPick={setLink} />
          )
        ) : (
          <div className="grid gap-1.5">
            <label
              className="text-xs text-muted-foreground"
              htmlFor={`${ids}-name`}
            >
              Customer name
            </label>
            <Input
              id={`${ids}-name`}
              value={typedName}
              onChange={(e) => setTypedName(e.target.value)}
              placeholder="Corner Street Bakery"
            />
          </div>
        )}

        {reps !== null && (
          <div className="grid gap-1.5">
            <label
              className="text-xs text-muted-foreground"
              htmlFor={`${ids}-rep`}
            >
              Rep
            </label>
            <select
              id={`${ids}-rep`}
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={repId}
              onChange={(e) => setRepId(e.target.value)}
            >
              <option value="">Choose a rep…</option>
              {reps.map((rep) => (
                <option key={rep.id} value={rep.id}>
                  {rep.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </section>

      <ProposalBuilder
        heading="Build the proposal"
        target={{
          groupId: null,
          leadId: mode === "record" && link?.type === "lead" ? link.id : null,
          merchantId:
            mode === "record" && link?.type === "merchant" ? link.id : null,
          customerName: mode === "typed" ? typedName : (link?.name ?? ""),
          agentId: repId,
        }}
        targetProblem={customerProblem ?? repProblem}
        initial={{ title: "", notes: "", cart: [] }}
        devices={devices}
        addons={addons}
        addonsByDevice={addonsByDevice}
      />
    </div>
  );
}

/** Search leads and merchants the caller can see, through search_crm(). */
function RecordSearch({
  inputId,
  onPick,
}: {
  inputId: string;
  onPick: (link: ProposalLink) => void;
}) {
  const [term, setTerm] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = term.trim();
  const tooShort = trimmed.length < MIN_SEARCH_LENGTH;

  useEffect(() => {
    if (tooShort) {
      setHits([]);
      setSearching(false);
      return;
    }
    // Guards against a slower earlier response overwriting a later one.
    let current = true;
    setSearching(true);
    const timer = setTimeout(async () => {
      const { data, error: rpcError } = await createClient().rpc("search_crm", {
        query_input: trimmed,
        limit_input: 8,
      });
      if (!current) return;
      setSearching(false);
      if (rpcError) {
        setError(rpcError.message);
        setHits([]);
        return;
      }
      setError(null);
      setHits(
        ((data ?? []) as SearchHit[]).filter(
          (hit) => hit.kind === "lead" || hit.kind === "merchant",
        ),
      );
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [trimmed, tooShort]);

  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs text-muted-foreground" htmlFor={inputId}>
        Search leads and merchants
      </label>
      <Input
        id={inputId}
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder="Business name, contact or phone"
        autoComplete="off"
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      {!tooShort && !searching && hits.length === 0 && error === null && (
        <p className="text-xs text-muted-foreground">No matching lead or merchant.</p>
      )}
      {hits.length > 0 && (
        <ul className="flex flex-col divide-y rounded-md border" aria-label="Matching records">
          {hits.map((hit) => {
            const name = hit.title ?? `#${hit.record_id}`;
            const type = hit.kind as QuoteOwnerType;
            return (
              <li key={`${hit.kind}-${hit.record_id}`}>
                <button
                  type="button"
                  className="flex w-full min-w-0 items-baseline gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                  onClick={() => onPick({ type, id: hit.record_id, name })}
                >
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {type === "lead" ? "Lead" : "Merchant"}
                  </span>
                  <span className="truncate font-medium">{name}</span>
                  {hit.subtitle && (
                    <span className="truncate text-xs text-muted-foreground">
                      {hit.subtitle}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
