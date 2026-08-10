"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { CheckIcon, Loader2Icon } from "lucide-react";

import {
  PRE_APP_STEPS,
  PRE_APP_STEP_LABELS,
  type PreAppStatus,
  type PreAppStep,
  nextStep,
  prevStep,
  stepHref,
} from "@/lib/pre-apps";
import type { Autosave } from "@/hooks/use-autosave";
import { PageHeader } from "@/components/page-header";
import { Callout } from "@/components/callout";
import { Button } from "@/components/ui/button";

/**
 * Lets the mounted step form hand its autosave handle up to the shell, so the
 * step navigation can flush before it navigates.
 *
 * A Set rather than a single slot: only one step form is mounted at a time
 * today, but the owners step may later split its rows into independently-saving
 * sub-forms, and a Set makes that a non-event.
 */
/**
 * What a step form exposes to the shell: its autosave handle, plus whether its
 * fields currently pass validation.
 *
 * Validity has to travel upward because the Next button lives in the shell
 * while the rules live in the step. Autosave stays deliberately blind to it —
 * a half-typed value is still saved, it just cannot be stepped past.
 */
type StepHandle = Autosave & { readonly isValid: boolean };

type Registry = {
  register: (handle: StepHandle) => () => void;
  flushAll: () => Promise<boolean>;
  hasPending: () => boolean;
};

const RegistryContext = React.createContext<Registry | null>(null);

export function useAutosaveRegistry(): Registry {
  const registry = React.useContext(RegistryContext);
  if (!registry) {
    throw new Error("useAutosaveRegistry must be used inside PreAppWizardShell");
  }
  return registry;
}

/** Registers a step's autosave and validity with the shell for its lifetime. */
export function useRegisterStep(autosave: Autosave, isValid: boolean): void {
  const { register } = useAutosaveRegistry();
  const latest = React.useRef({ autosave, isValid });
  latest.current = { autosave, isValid };

  React.useEffect(() => {
    // Registers a stable proxy that reads through a ref, so the Set is not
    // churned on every keystroke — re-registering per render would mean adding
    // and removing an entry for each character typed.
    return register({
      get state() {
        return latest.current.autosave.state;
      },
      get hasPendingChanges() {
        return latest.current.autosave.hasPendingChanges;
      },
      get isValid() {
        return latest.current.isValid;
      },
      flush: () => latest.current.autosave.flush(),
      retry: () => latest.current.autosave.retry(),
    });
  }, [register]);
}

export function PreAppWizardShell({
  preAppId,
  dbaName,
  step,
  status,
  isAdmin,
  children,
}: {
  preAppId: number;
  dbaName: string;
  step: PreAppStep;
  status: PreAppStatus;
  isAdmin: boolean;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const entries = React.useRef(new Set<StepHandle>());
  const [saveState, setSaveState] = React.useState<Autosave["state"]>({
    status: "idle",
  });
  const [stepIsValid, setStepIsValid] = React.useState(true);

  const register = React.useCallback((handle: StepHandle) => {
    entries.current.add(handle);
    return () => {
      entries.current.delete(handle);
    };
  }, []);

  const flushAll = React.useCallback(async () => {
    const results = await Promise.all(
      [...entries.current].map((entry) => entry.flush()),
    );
    return results.every(Boolean);
  }, []);

  const hasPending = React.useCallback(
    () => [...entries.current].some((entry) => entry.hasPendingChanges),
    [],
  );

  const registry = React.useMemo<Registry>(
    () => ({ register, flushAll, hasPending }),
    [register, flushAll, hasPending],
  );

  // Polled rather than pushed. The alternative is for the step to call a setter
  // on every autosave state change, which turns each keystroke into a re-render
  // of the whole shell including the nav. 400ms is imperceptible for a status
  // line and costs nothing.
  React.useEffect(() => {
    const tick = setInterval(() => {
      const handles = [...entries.current];
      setSaveState(handles[0] ? handles[0].state : { status: "idle" });
      setStepIsValid(handles.every((handle) => handle.isValid));
    }, 400);
    return () => clearInterval(tick);
  }, []);

  /**
   * Real `<Link>`s, so middle-click, copy-link and back/forward all behave, with
   * a plain left-click intercepted to flush first.
   */
  const navigate = async (
    event: React.MouseEvent,
    href: string,
  ): Promise<void> => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
      return; // let the browser have it
    }
    if (!hasPending()) return; // nothing to flush; the Link handles it
    event.preventDefault();
    const ok = await flushAll();
    // On failure, stay put — the status line is already showing why.
    if (!ok) return;
    router.push(href);
    router.refresh();
  };

  const back = prevStep(step);
  const forward = nextStep(step);

  return (
    <RegistryContext.Provider value={registry}>
      <div className="flex flex-col gap-6">
        <PageHeader
          title={dbaName}
          subtitle={`Pre-app #${preAppId} · changes save as you go.`}
        />

        {status !== "draft" && isAdmin && (
          // An admin editing a record someone else has already submitted for
          // review deserves to be told, rather than discovering it from the
          // status badge. Autosave means every keystroke is already committed.
          <Callout tone="warning">
            This pre-app is <strong>{status}</strong>. You&rsquo;re editing it as
            an admin and changes are saved immediately.
          </Callout>
        )}

        <nav className="flex flex-wrap gap-2">
          {PRE_APP_STEPS.map((candidate) => {
            const href = stepHref(preAppId, candidate);
            const isCurrent = candidate === step;
            return (
              <Button
                key={candidate}
                asChild
                size="sm"
                variant={isCurrent ? "default" : "outline"}
              >
                {/* prefetch={false}: prefetching every step's dynamic render is
                    wasted work when the rep will visit at most a few. */}
                <Link
                  href={href}
                  prefetch={false}
                  aria-current={isCurrent ? "step" : undefined}
                  onClick={(event) => void navigate(event, href)}
                >
                  {PRE_APP_STEP_LABELS[candidate]}
                </Link>
              </Button>
            );
          })}
        </nav>

        {children}

        <div className="flex items-center justify-between gap-4 border-t pt-4">
          <SaveStatus state={saveState} onRetry={() => void flushAll()} />

          <div className="flex gap-2">
            {back && (
              <Button asChild variant="outline" size="sm">
                <Link
                  href={stepHref(preAppId, back)}
                  prefetch={false}
                  onClick={(event) =>
                    void navigate(event, stepHref(preAppId, back))
                  }
                >
                  Back
                </Link>
              </Button>
            )}
            {forward ? (
              stepIsValid ? (
                <Button asChild size="sm">
                  <Link
                    href={stepHref(preAppId, forward)}
                    prefetch={false}
                    onClick={(event) =>
                      void navigate(event, stepHref(preAppId, forward))
                    }
                  >
                    Next
                  </Link>
                </Button>
              ) : (
                // A real disabled <button>, not a styled link. `asChild` renders
                // the Link as the element, and an anchor ignores the `disabled`
                // attribute entirely — it would still navigate on click and only
                // look inactive. The step's own links stay live on purpose: a rep
                // who wants to leave a half-finished field should not be trapped,
                // and everything typed is saved regardless. The real gate is
                // submit_pre_app.
                <Button
                  type="button"
                  size="sm"
                  disabled
                  title="Fix the highlighted fields to continue"
                >
                  Next
                </Button>
              )
            ) : (
              <Button asChild size="sm" variant="outline">
                <Link href={`/pre-apps/${preAppId}`}>Done</Link>
              </Button>
            )}
          </div>
        </div>
      </div>
    </RegistryContext.Provider>
  );
}

/**
 * The save indicator.
 *
 * The relative clock lives here rather than in the hook: a ticking timer in the
 * hook would re-render the whole step form every few seconds, and reading
 * `Date.now()` during a server render is a hydration hazard. This is a client
 * component that renders nothing until the first save resolves, so there is no
 * server-rendered timestamp to mismatch.
 */
function SaveStatus({
  state,
  onRetry,
}: {
  state: Autosave["state"];
  onRetry: () => void;
}) {
  const [, setTick] = React.useState(0);

  React.useEffect(() => {
    if (state.status !== "saved") return;
    const timer = setInterval(() => setTick((n) => n + 1), 10_000);
    return () => clearInterval(timer);
  }, [state.status]);

  if (state.status === "idle") return <span />;

  if (state.status === "saving") {
    return (
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2Icon size={14} className="animate-spin" />
        Saving…
      </span>
    );
  }

  if (state.status === "error") {
    return (
      <span className="flex items-center gap-2 text-sm text-destructive">
        {state.message}
        <Button type="button" size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      </span>
    );
  }

  return (
    <span className="flex items-center gap-2 text-sm text-muted-foreground">
      <CheckIcon size={14} />
      Saved {relativeTime(state.at)}
    </span>
  );
}

function relativeTime(at: number): string {
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}
