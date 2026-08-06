"use client";

import * as React from "react";

import { applyMask } from "@/lib/masks";
import { Input } from "@/components/ui/input";

/**
 * A controlled input that reformats as the rep types and keeps the caret where
 * they left it.
 *
 * The caret handling is the whole reason this component exists. With a
 * controlled input you cannot set `selectionStart` inside `onChange`: React
 * re-renders afterwards and writing `input.value` puts the caret at the end. So
 * `onChange` stashes the target position in a ref and a `useLayoutEffect` keyed
 * on the incoming value restores it after the DOM write. `useLayoutEffect`
 * rather than `requestAnimationFrame` — the latter paints the wrong caret
 * position first, which reads as a visible jump.
 *
 * The value handed to `onChange` is always the masked one, so form state and the
 * database only ever see formatted text.
 */
export const MaskedInput = React.forwardRef<
  HTMLInputElement,
  Omit<React.ComponentProps<"input">, "value" | "onChange"> & {
    mask: (value: string) => string;
    value: string;
    onChange: (value: string) => void;
  }
>(function MaskedInput({ mask, value, onChange, ...rest }, forwardedRef) {
  const inner = React.useRef<HTMLInputElement | null>(null);
  const caret = React.useRef<number | null>(null);

  React.useLayoutEffect(() => {
    const el = inner.current;
    if (el && caret.current !== null && document.activeElement === el) {
      el.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
  }, [value]);

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const el = event.currentTarget;
    const raw = el.value;
    const at = el.selectionStart ?? raw.length;
    const deletingBackward =
      (event.nativeEvent as InputEvent).inputType === "deleteContentBackward";

    const next = applyMask(mask, value, raw, at, deletingBackward);
    caret.current = next.caret;
    // field.onChange, so RHF marks the field dirty and the autosave subscription
    // sees a named change. A non-dirtying setValue would be excluded from the
    // patch and the masked value would never reach the database.
    onChange(next.value);
  };

  return (
    <Input
      {...rest}
      ref={(node) => {
        inner.current = node;
        if (typeof forwardedRef === "function") forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      }}
      value={value}
      onChange={handleChange}
    />
  );
});
