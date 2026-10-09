"use client";

import { useId, useState } from "react";
import { XIcon } from "lucide-react";

import { matchesDeviceSearch } from "@/lib/brands";
import { Input } from "@/components/ui/input";

export type DeviceOption = { id: number; name: string; sku: string | null };

/**
 * "Fits these devices" for an add-on: a search box over one brand's live
 * devices, with the chosen ones shown as removable chips above it.
 *
 * Replaces a checkbox per device in the catalog. With forty devices that was
 * a wall an admin had to scan for every accessory; this lists only the brand's
 * own devices, and only the ones matching what was typed.
 *
 * Controlled and write-free: it reports the chosen ids to its form, and the
 * form writes product_compatibility on Save. Choosing a device here is a draft
 * until then, the same as every other field beside it.
 *
 * Follows the ARIA combobox pattern — the input owns focus throughout, the
 * highlighted option is announced through aria-activedescendant, and the
 * options are picked on mousedown with preventDefault so clicking one never
 * blurs the input and closes the list under the pointer.
 */
export function DeviceMultiSelect({
  id,
  options,
  selected,
  names,
  onChange,
  disabled = false,
}: {
  /** The input's id, for the <label> the form renders. */
  id: string;
  /** The devices that may be chosen: this brand's, live. */
  options: readonly DeviceOption[];
  selected: readonly number[];
  /**
   * id -> name for EVERY device, not just `options`. A link recorded before a
   * product changed brand, or to a device since archived, must still render
   * as a chip the admin can see and remove — otherwise it is a link nobody
   * can find.
   */
  names: Readonly<Record<number, string>>;
  onChange: (ids: number[]) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();

  const chosen = new Set(selected);
  const matches = options.filter(
    (device) => !chosen.has(device.id) && matchesDeviceSearch(device, query),
  );
  const activeIndex = Math.min(active, Math.max(matches.length - 1, 0));

  // Closes the list on a pick. Left open, it hangs over whatever sits below
  // the field — on the product form that is the Save button, which the e2e
  // spec found it covering. Typing, ArrowDown or a click on the field reopens
  // it to choose another.
  const pick = (deviceId: number) => {
    onChange([...selected, deviceId]);
    setQuery("");
    setActive(0);
    setOpen(false);
  };

  const remove = (deviceId: number) => {
    onChange(selected.filter((existing) => existing !== deviceId));
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive(Math.min(activeIndex + 1, matches.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(Math.max(activeIndex - 1, 0));
    } else if (event.key === "Enter") {
      // Never submits anything: the form saves on its own button, and an
      // Enter meant to pick a device must not also save a half-typed product.
      event.preventDefault();
      if (open && matches[activeIndex]) pick(matches[activeIndex].id);
    } else if (event.key === "Escape") {
      setOpen(false);
    } else if (
      event.key === "Backspace" &&
      query === "" &&
      selected.length > 0
    ) {
      remove(selected[selected.length - 1]);
    }
  };

  const optionId = (deviceId: number) => `${listId}-option-${deviceId}`;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {selected.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Chosen devices">
          {selected.map((deviceId) => {
            const name = names[deviceId] ?? `Product #${deviceId}`;
            return (
              <li
                key={deviceId}
                className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border bg-muted py-0.5 pl-2.5 pr-1 text-xs"
              >
                <span className="truncate">{name}</span>
                <button
                  type="button"
                  className="rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label={`Remove ${name}`}
                  disabled={disabled}
                  onClick={() => remove(deviceId)}
                >
                  <XIcon size={12} />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="relative">
        <Input
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            open && matches[activeIndex]
              ? optionId(matches[activeIndex].id)
              : undefined
          }
          autoComplete="off"
          placeholder={
            options.length === 0
              ? "This brand has no live devices yet"
              : "Search this brand's devices…"
          }
          value={query}
          disabled={disabled || options.length === 0}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
        />
        {open && (
          <ul
            id={listId}
            role="listbox"
            aria-label="Devices"
            className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
          >
            {matches.length === 0 ? (
              <li className="px-2 py-1.5 text-xs text-muted-foreground">
                {options.length > 0 && options.every((d) => chosen.has(d.id))
                  ? "Every device in this brand is already chosen."
                  : "No matching device."}
              </li>
            ) : (
              matches.map((device, index) => (
                <li
                  key={device.id}
                  id={optionId(device.id)}
                  role="option"
                  aria-selected={index === activeIndex}
                  className={
                    "flex min-w-0 cursor-pointer items-baseline gap-2 rounded px-2 py-1.5 text-sm " +
                    (index === activeIndex ? "bg-accent" : "")
                  }
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(device.id);
                  }}
                  onMouseEnter={() => setActive(index)}
                >
                  <span className="truncate">{device.name}</span>
                  {device.sku && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {device.sku}
                    </span>
                  )}
                </li>
              ))
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
