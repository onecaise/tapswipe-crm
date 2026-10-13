"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Asks the browser to confirm leaving (reload, close, typed URL) while `active`
 * (D-07 / C3a). The browser shows its own fixed wording; nothing custom can be
 * put in it.
 *
 * Deliberately a warning and nothing more: it does NOT keep the form's contents
 * anywhere — no localStorage, sessionStorage or cookie. Restoring a half-filled
 * form after a refresh would mean writing what was typed into browser storage,
 * and on the pre-app secrets step that is an SSN and a bank account sitting in
 * plain text on a shared machine. Losing a draft is the better failure.
 *
 * Client-side navigation (a <Link>, router.push) never fires beforeunload, so a
 * successful submit that routes away is not interrupted. The pre-app wizard's
 * autosave has its own pending-save warning in hooks/use-autosave.ts.
 */
export function useUnsavedChangesWarning(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older Chromium still needs returnValue set to show the prompt.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);
}

/**
 * "Has the person typed anything into this form yet?" — for forms whose state
 * is a dozen separate useState calls, where comparing every field to its start
 * value would be a second copy of the form. Spread `onInput` onto the <form>:
 * input events bubble from every field inside it.
 */
export function useTypedInput(): { dirty: boolean; onInput: () => void } {
  const [dirty, setDirty] = useState(false);
  const onInput = useCallback(() => setDirty(true), []);
  return { dirty, onInput };
}
