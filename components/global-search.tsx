"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { Loader2Icon, SearchIcon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import {
  MIN_SEARCH_LENGTH,
  SEARCH_KIND_META,
  type SearchHit,
  groupHits,
} from "@/lib/search";
import { cn } from "@/lib/utils";

/** Long enough that typing a name isn't one request per keystroke. */
const DEBOUNCE_MS = 250;

/** Per record kind, matching the RPC's own default. */
const LIMIT_PER_KIND = 5;

/**
 * The top bar's search box.
 *
 * Calls the `search_crm` RPC from the browser through the anon-key client. That
 * is safe *because* the function is SECURITY INVOKER: the caller's JWT reaches
 * Postgres, their own select policies scope every table the function reads, and
 * an agent physically cannot get back a record their list pages would hide. No
 * filtering happens here, and none should be added — a filter in the browser
 * would be a second copy of the access rule, free to drift from the policies.
 */
export function GlobalSearch() {
  const listboxId = useId();

  const [term, setTerm] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const trimmed = term.trim();
  const tooShort = trimmed.length < MIN_SEARCH_LENGTH;

  useEffect(() => {
    if (tooShort) {
      // Skipping the request the function would answer with zero rows anyway.
      setHits([]);
      setSearching(false);
      setError(null);
      return;
    }

    // Guards against an earlier, slower response overwriting a later one — the
    // reason results can otherwise flicker back to a previous term.
    let current = true;
    setSearching(true);

    const timer = setTimeout(async () => {
      const supabase = createClient();
      const { data, error: rpcError } = await supabase.rpc("search_crm", {
        query_input: trimmed,
        limit_input: LIMIT_PER_KIND,
      });

      if (!current) return;

      if (rpcError) {
        setError(rpcError.message);
        setHits([]);
      } else {
        setError(null);
        setHits((data ?? []) as SearchHit[]);
      }
      setSearching(false);
    }, DEBOUNCE_MS);

    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [trimmed, tooShort]);

  // Pointerdown rather than blur: a blur handler fires before the click that
  // caused it, so closing on blur eats the click on a result.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    inputRef.current?.blur();
  };

  /** Moves focus between the input and the result links with the arrow keys. */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      close();
      return;
    }

    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;

    const links = Array.from(
      containerRef.current?.querySelectorAll<HTMLAnchorElement>(
        "[data-search-hit]",
      ) ?? [],
    );
    if (links.length === 0) return;

    event.preventDefault();
    const index = links.indexOf(document.activeElement as HTMLAnchorElement);

    if (event.key === "ArrowDown") {
      (index === -1 || index === links.length - 1
        ? links[0]
        : links[index + 1]
      ).focus();
    } else if (index <= 0) {
      inputRef.current?.focus();
    } else {
      links[index - 1].focus();
    }
  };

  const groups = groupHits(hits);
  const showPanel = open && !tooShort;

  return (
    <div
      ref={containerRef}
      className="relative w-full max-w-sm"
      onKeyDown={onKeyDown}
    >
      <SearchIcon
        size={16}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <input
        ref={inputRef}
        type="text"
        // Not type="search": the WebKit clear button lands on top of the
        // spinner, and Escape already clears the panel.
        value={term}
        onChange={(event) => {
          setTerm(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Search leads, merchants, tickets…"
        aria-label="Search records"
        role="combobox"
        aria-expanded={showPanel}
        aria-controls={listboxId}
        aria-autocomplete="list"
        className="h-9 w-full rounded-full bg-muted pl-9 pr-9 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      {searching && (
        <Loader2Icon
          size={15}
          className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-muted-foreground"
          aria-hidden
        />
      )}

      {showPanel && (
        <div
          id={listboxId}
          className="absolute left-0 right-0 top-11 z-20 max-h-[70vh] overflow-y-auto rounded-xl border bg-popover p-1 shadow-lg"
        >
          {error !== null ? (
            <p className="px-3 py-2 text-sm text-destructive">
              Search failed: {error}
            </p>
          ) : groups.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">
              {searching ? "Searching…" : `No matches for “${trimmed}”.`}
            </p>
          ) : (
            groups.map((group) => {
              const meta = SEARCH_KIND_META[group.kind];
              const Icon = meta.icon;

              return (
                <div key={group.kind} className="pb-1">
                  <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {meta.label}
                  </p>
                  {group.hits.map((hit) => (
                    <Link
                      key={`${hit.kind}-${hit.record_id}`}
                      href={meta.href(hit.record_id)}
                      data-search-hit
                      onClick={close}
                      className={cn(
                        "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm",
                        "hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
                      )}
                    >
                      <Icon
                        size={15}
                        className="shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                      <span className="min-w-0">
                        <span className="block truncate font-medium">
                          {hit.title}
                        </span>
                        {hit.subtitle !== null && hit.subtitle !== hit.title && (
                          <span className="block truncate text-xs text-muted-foreground">
                            {hit.subtitle}
                          </span>
                        )}
                      </span>
                    </Link>
                  ))}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
