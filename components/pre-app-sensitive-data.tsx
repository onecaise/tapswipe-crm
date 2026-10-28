"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

import { createClient } from "@/lib/supabase/client";
import { invokeEdgeFunction } from "@/lib/edge-functions";
import type { PreApp } from "@/lib/pre-apps";
import {
  maskedLast4,
  REVEAL_TIMEOUT_MS,
  revealBody,
  revealKey,
  type RevealedSecret,
  type RevealTarget,
  type SecretsStatus,
} from "@/lib/pre-app-secrets";
import { Button } from "@/components/ui/button";

/**
 * The detail page's "Sensitive data" section (phase 5, memo §1.E / A24).
 *
 * Everyone sees the same masked view: the last four of each owner SSN, the
 * tax ID, the routing and the account number, and "on file" for the RP
 * password. An admin also gets a per-field Show, which asks
 * read-pre-app-secrets for that ONE value; the function audits the reveal
 * and rate-limits it before it decrypts anything.
 *
 * Where a revealed value may exist: this component's state, and the DOM while
 * it is shown. Nowhere else.
 *  - Fetched client-side after mount, so it is never in the server render or
 *    the RSC payload (the page's HTML holds no digit of any secret).
 *  - Masked again after REVEAL_TIMEOUT_MS, on navigation (the pathname effect,
 *    and `key` on the caller so another pre-app never inherits state), when the
 *    tab is hidden, on pagehide (so a back-forward cache restore has nothing),
 *    and on beforeprint.
 *  - `print:hidden` on the value with a masked twin shown only in print, as a
 *    backstop for a print that fires no beforeprint.
 *  - Never written to a URL, storage, the wizard's autosave or a log.
 */
export function PreAppSensitiveData({
  preAppId,
  einType,
  isAdmin,
}: {
  preAppId: number;
  einType: PreApp["ein_type"];
  isAdmin: boolean;
}) {
  const [status, setStatus] = useState<SecretsStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const pathname = usePathname();

  const maskAll = useCallback(() => {
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
    setRevealed({});
  }, []);

  const mask = useCallback((key: string) => {
    const timer = timers.current.get(key);
    if (timer) clearTimeout(timer);
    timers.current.delete(key);
    setRevealed((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, error } = await invokeEdgeFunction<SecretsStatus>(
        createClient(),
        "read-pre-app-secrets",
        { pre_app_id: preAppId },
        "Could not read what is on file.",
      );
      if (cancelled) return;
      if (error) setLoadError(error);
      else setStatus(data);
    })();
    return () => {
      cancelled = true;
    };
  }, [preAppId]);

  // Navigation: a new pathname masks everything. Unmount clears the timers;
  // the state goes with the component.
  useEffect(() => maskAll, [pathname, maskAll]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") maskAll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", maskAll);
    window.addEventListener("beforeprint", maskAll);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", maskAll);
      window.removeEventListener("beforeprint", maskAll);
    };
  }, [maskAll]);

  const reveal = async (target: RevealTarget) => {
    const key = revealKey(target);
    setPending(key);
    setRevealError(null);
    try {
      const { data, error } = await invokeEdgeFunction<RevealedSecret>(
        createClient(),
        "read-pre-app-secrets",
        revealBody(preAppId, target),
        "Could not show this value. Nothing was revealed.",
      );
      if (error || !data) {
        setRevealError(error ?? "Could not show this value. Nothing was revealed.");
        return;
      }
      // Hidden tab between click and answer: do not show it at all.
      if (document.visibilityState === "hidden") return;
      setRevealed((prev) => ({ ...prev, [key]: data.value }));
      const old = timers.current.get(key);
      if (old) clearTimeout(old);
      timers.current.set(key, setTimeout(() => mask(key), REVEAL_TIMEOUT_MS));
    } finally {
      setPending(null);
    }
  };

  const row = (
    label: string,
    onFile: boolean,
    masked: string,
    target: RevealTarget,
    showLabel: string,
  ) => {
    const key = revealKey(target);
    const value = revealed[key];
    return (
      <div key={key} className="flex flex-col gap-1">
        <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
        <dd className="flex flex-wrap items-center gap-3 text-sm">
          {!onFile ? (
            <span className="text-muted-foreground">Not on file</span>
          ) : value === undefined ? (
            <span className="font-mono">{masked}</span>
          ) : (
            <>
              <span className="font-mono print:hidden" data-revealed="">
                {value}
              </span>
              <span className="hidden font-mono print:inline">{masked}</span>
            </>
          )}
          {isAdmin && onFile && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 print:hidden"
              aria-label={value === undefined ? showLabel : showLabel.replace(/^Show/, "Hide")}
              disabled={pending !== null}
              onClick={() => (value === undefined ? void reveal(target) : mask(key))}
            >
              {pending === key ? "Showing…" : value === undefined ? "Show" : "Hide"}
            </Button>
          )}
        </dd>
      </div>
    );
  };

  const tax = status?.tax_id;
  const taxKindMismatch =
    Boolean(tax?.on_file) && einType !== null && tax?.tax_id_type !== einType;

  return (
    <section className="flex flex-col gap-4" aria-labelledby="sensitive-data-heading">
      <h2 id="sensitive-data-heading" className="font-semibold text-lg">
        Sensitive data
      </h2>
      <p className="text-sm text-muted-foreground">
        Encrypted, and shown as the last four only.
        {isAdmin &&
          ` Show reveals one value, records that you did, and hides it again after ${
            REVEAL_TIMEOUT_MS / 1000
          } seconds, when you leave this tab or page, or print.`}
      </p>

      {loadError && <p className="text-sm text-destructive">{loadError}</p>}
      {revealError && (
        <p role="alert" className="text-sm text-destructive">
          {revealError}
        </p>
      )}

      {status === null && loadError === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : status ? (
        <dl className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {row(
            `Tax ID (${tax?.tax_id_type ?? einType ?? "EIN or SSN"})`,
            Boolean(tax?.on_file),
            maskedLast4(tax?.tax_id_last4),
            { field: "tax_id" },
            "Show tax ID",
          )}
          {status.owners.map((owner) => {
            const name = owner.owner_name ?? `Owner #${owner.pre_app_owner_id}`;
            return row(
              `SSN — ${name}`,
              owner.ssn_on_file,
              maskedLast4(owner.ssn_last4),
              { field: "owner_ssn", preAppOwnerId: owner.pre_app_owner_id },
              `Show SSN for ${name}`,
            );
          })}
          {row(
            "ABA routing",
            status.banking.on_file,
            maskedLast4(status.banking.aba_routing_last4),
            { field: "aba_routing" },
            "Show routing number",
          )}
          {row(
            "Account number",
            status.banking.on_file,
            maskedLast4(status.banking.account_number_last4),
            { field: "account_number" },
            "Show account number",
          )}
          {row(
            "RP password",
            status.terminal.on_file,
            "On file",
            { field: "rp_password" },
            "Show RP password",
          )}
        </dl>
      ) : null}

      {taxKindMismatch && (
        <p className="text-sm text-warning">
          The tax ID on file is an {tax?.tax_id_type}, but EIN type says {einType}.
        </p>
      )}
    </section>
  );
}
