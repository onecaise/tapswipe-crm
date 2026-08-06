"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import { filterStates, isState } from "@/lib/masks";
import { Input } from "@/components/ui/input";

/**
 * A state picker that accepts typing but only ever commits a real state code.
 *
 * Typing filters the list and highlights the first match, so "T" lands on TN and
 * "tenn" also finds it — the rule lives in `filterStates`, shared with
 * `matchState`, so the highlight and the visible list cannot disagree.
 *
 * The invariant that matters: **`onChange` is only ever called with a valid code
 * or `""`.** Anything half-typed lives in local state and is discarded on blur
 * unless it resolves to exactly one intent. That is what makes "no value outside
 * the list" true of the form state rather than merely true of the UI.
 *
 * Built without cmdk or a popover library on purpose. This needs 51 options, a
 * prefix filter and four keys; the shared rule above is the only interesting
 * part, and two dependencies to get a listbox is a poor trade. (A native
 * `<select>` would also enforce list membership and comes with typeahead for
 * free, but only against the option label — so "tenn" would not find TN.)
 */
export function StateCombobox({
  value,
  onChange,
  id,
  disabled,
  "aria-invalid": ariaInvalid,
}: {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  disabled?: boolean;
  "aria-invalid"?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [highlight, setHighlight] = React.useState(0);
  const listRef = React.useRef<HTMLUListElement | null>(null);

  const matches = React.useMemo(() => filterStates(query), [query]);

  // What the input shows: the query while typing, the committed code otherwise.
  const shown = open ? query : value;

  const commit = (code: string) => {
    onChange(code);
    setQuery("");
    setOpen(false);
    setHighlight(0);
  };

  /**
   * Leaving the field must not strand an unparseable value. If what was typed
   * resolves to a state, take it; otherwise fall back to whatever was already
   * committed. Never write the raw text through.
   */
  const settle = () => {
    if (!open) return;
    if (query.trim() === "") {
      // Cleared on purpose — an empty state is legitimate, the column is nullable.
      commit("");
      return;
    }
    const resolved = matches[0]?.code;
    commit(resolved && isState(resolved) ? resolved : value);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setHighlight((current) => {
        const next = current + delta;
        if (next < 0) return matches.length - 1;
        if (next >= matches.length) return 0;
        return next;
      });
      return;
    }
    if (event.key === "Enter") {
      if (!open) return;
      event.preventDefault();
      const picked = matches[highlight];
      if (picked) commit(picked.code);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setQuery("");
      setOpen(false);
      setHighlight(0);
      return;
    }
    if (event.key === "Tab") {
      settle();
    }
  };

  // Keep the highlighted row in view when arrowing through 51 options.
  React.useEffect(() => {
    if (!open) return;
    const node = listRef.current?.children[highlight] as HTMLElement | undefined;
    node?.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  return (
    <div className="relative">
      <Input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-invalid={ariaInvalid}
        autoComplete="off"
        disabled={disabled}
        value={shown}
        placeholder="TN"
        onFocus={() => {
          setOpen(true);
          setQuery(value);
          setHighlight(0);
        }}
        onBlur={settle}
        onChange={(event) => {
          setQuery(event.target.value);
          setHighlight(0);
          setOpen(true);
        }}
        onKeyDown={handleKeyDown}
      />

      {open && matches.length > 0 && (
        <ul
          ref={listRef}
          role="listbox"
          className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md border bg-popover p-1 shadow-md"
        >
          {matches.map((state, index) => (
            <li
              key={state.code}
              role="option"
              aria-selected={index === highlight}
              className={cn(
                "cursor-pointer rounded-sm px-2 py-1.5 text-sm",
                index === highlight && "bg-accent text-accent-foreground",
              )}
              // onMouseDown, not onClick: onClick would fire after onBlur has
              // already settled the field and closed the list.
              onMouseDown={(event) => {
                event.preventDefault();
                commit(state.code);
              }}
              onMouseEnter={() => setHighlight(index)}
            >
              <span className="font-medium">{state.code}</span>
              <span className="text-muted-foreground"> — {state.name}</span>
            </li>
          ))}
        </ul>
      )}

      {open && matches.length === 0 && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover p-3 text-sm text-muted-foreground shadow-md">
          No state matches “{query}”.
        </div>
      )}
    </div>
  );
}
