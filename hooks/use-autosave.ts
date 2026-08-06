"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FieldValues, UseFormReturn } from "react-hook-form";

export type AutosaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved"; at: number }
  | { status: "error"; message: string };

export type Autosave = {
  state: AutosaveState;
  /** True while anything is queued or in flight. Drives the unload warning. */
  hasPendingChanges: boolean;
  /**
   * Cancel the debounce, wait for any in-flight save, then write whatever is
   * still dirty. Resolves false if the save failed. Awaited by step navigation.
   */
  flush: () => Promise<boolean>;
  /** Re-queue the keys from a failed save and try again. */
  retry: () => Promise<boolean>;
};

/** Reads a possibly-nested RHF path (`owners.2.home_city`) off a values object. */
function readPath(values: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    return (acc as Record<string, unknown>)[key];
  }, values);
}

/**
 * Debounced, dirty-field-only autosave for one wizard step.
 *
 * ## Why the payload comes from a hook-owned key set, not `dirtyFields`
 *
 * The obvious implementation is: send `formState.dirtyFields`, then
 * `form.reset(getValues())` on success to clear them. **That loses data.**
 * Type in `city` at t=0; the write goes out at t=2s; type in `zip` at t=2.1s;
 * the response lands at t=2.3s and `reset()` marks *everything* clean —
 * including `zip`, which still holds its value but is now invisible to every
 * later diff and is never written. The rep sees "Saved", reloads tomorrow, and
 * the field is empty. React Hook Form has no API to clear one field's dirty
 * flag, so `reset()` is all-or-nothing and the race is structural rather than a
 * tuning problem.
 *
 * A hook-owned `Set` of pending paths avoids it by construction: the set is
 * cleared *before* awaiting, so a keystroke arriving mid-flight re-adds its own
 * key and is picked up by the next pass.
 *
 * ## Why `info.name` is the right mount/reset guard
 *
 * `form.watch(cb)` fires with `name: undefined` on the initial subscribe and on
 * a programmatic `reset()`, and with the field's name for a user keystroke *and*
 * for `setValue`. That asymmetry is exactly what is needed: a server-driven
 * reset must never trigger a write, while the mask's programmatic write must.
 * The corollary is that masked fields have to route through `field.onChange` or
 * `setValue`, never through `reset()`.
 *
 * ## Deliberately validity-blind
 *
 * This never calls `trigger()` and never reads `formState.errors`. A half-typed
 * EIN has to persist — losing eight keystrokes to a closed tab is the thing
 * autosave exists to prevent. Blocking *navigation* on validity is the step
 * form's job, not this hook's.
 */
export function useAutosave<T extends FieldValues>({
  form,
  save,
  enabled = true,
  debounceMs = 2000,
}: {
  form: UseFormReturn<T>;
  /** Receives the dirty subset of raw form values, plus the paths that changed. */
  save: (patch: Partial<T>, keys: string[]) => Promise<void>;
  enabled?: boolean;
  debounceMs?: number;
}): Autosave {
  const [state, setState] = useState<AutosaveState>({ status: "idle" });
  const [hasPendingChanges, setHasPendingChanges] = useState(false);

  const pendingKeys = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const saving = useRef(false);
  const queued = useRef(false);
  const generation = useRef(0);
  const cancelled = useRef(false);

  // Held in refs so the subscription effect can run exactly once. Re-subscribing
  // on every render would drop keystrokes in the gap between teardown and setup.
  const saveRef = useRef(save);
  saveRef.current = save;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const formRef = useRef(form);
  formRef.current = form;

  const run = useCallback(async (): Promise<boolean> => {
    if (saving.current) {
      // Serialise. Two overlapping PATCHes to the same row have no defined
      // ordering, and with last-write-wins the older one can win.
      queued.current = true;
      return inFlight.current ?? true;
    }

    const keys = [...pendingKeys.current];
    if (keys.length === 0) return true;

    // Cleared before awaiting, so a keystroke during the request re-adds itself.
    pendingKeys.current.clear();

    const values = formRef.current.getValues();
    const patch = Object.fromEntries(
      keys.map((key) => [key, readPath(values, key)]),
    ) as Partial<T>;

    saving.current = true;
    const gen = ++generation.current;
    if (!cancelled.current) setState({ status: "saving" });

    inFlight.current = (async () => {
      try {
        await saveRef.current(patch, keys);
        // A response from an older generation must not overwrite newer state.
        if (gen === generation.current && !cancelled.current) {
          setState({ status: "saved", at: Date.now() });
        }
        return true;
      } catch (err: unknown) {
        // Re-queue so Retry has something to send.
        keys.forEach((key) => pendingKeys.current.add(key));
        if (gen === generation.current && !cancelled.current) {
          setState({
            status: "error",
            message:
              err instanceof Error ? err.message : "Could not save changes.",
          });
        }
        return false;
      } finally {
        saving.current = false;
        if (!cancelled.current) {
          setHasPendingChanges(pendingKeys.current.size > 0);
        }
        if (queued.current) {
          queued.current = false;
          void run();
        }
      }
    })();

    return inFlight.current;
  }, []);

  useEffect(() => {
    cancelled.current = false;
    const subscription = formRef.current.watch((_values, info) => {
      // Undefined name means mount or a programmatic reset — never a user edit.
      if (!info.name || !enabledRef.current) return;
      pendingKeys.current.add(info.name);
      setHasPendingChanges(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void run(), debounceMs);
    });

    return () => {
      subscription.unsubscribe();
      clearTimeout(timer.current);
      // Blocks setState after unmount. Deliberately does NOT fire a final save:
      // React StrictMode double-invokes effects in development, so every mount
      // would issue a duplicate write, and by cleanup time there is nowhere left
      // to render a failure. Navigation awaits flush() explicitly instead.
      cancelled.current = true;
    };
  }, [run, debounceMs]);

  const flush = useCallback(async (): Promise<boolean> => {
    clearTimeout(timer.current);
    if (saving.current && inFlight.current) await inFlight.current;
    return run();
  }, [run]);

  const retry = useCallback(async (): Promise<boolean> => flush(), [flush]);

  // A hard tab close can still lose up to one debounce interval. sendBeacon is
  // not a fix — it cannot reliably carry the Supabase auth header and its result
  // is unobservable, so it would produce a silent maybe-saved.
  useEffect(() => {
    if (!hasPendingChanges) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasPendingChanges]);

  return { state, hasPendingChanges, flush, retry };
}
