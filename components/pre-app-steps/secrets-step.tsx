"use client";

import { useCallback, useEffect, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import type { PreAppOwner } from "@/lib/pre-apps";
import {
  isAccount,
  isRouting,
  isSsn,
  maskAccount,
  maskRouting,
  maskSsn,
} from "@/lib/masks";
import { MaskedInput } from "@/components/masked-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * SSN, bank routing/account and the terminal RP password.
 *
 * This step is deliberately unlike every other one:
 *
 *  - **No autosave.** These values cannot be written by supabase-js at all — the
 *    three *_secrets tables have RLS with zero policies and no grant to any
 *    client role. The only way in is submit-pre-app-secrets, and it is reached by
 *    an explicit button rather than a debounce, so nothing is transmitted until
 *    the rep means it.
 *  - **Values are cleared from component state the moment the write succeeds**,
 *    and never re-populated from the server. What comes back is a status, never a
 *    value.
 *  - **Status is fetched client-side.** Deliberate: a server-rendered secret ends
 *    up in the RSC payload, which means it is in the HTML and in browser memory
 *    for the life of the page. Fetching here keeps even the last-4 out of that,
 *    and an admin's full reveal never touches the server render at all.
 */
type SecretsStatus = {
  tier: "full" | "last4";
  owners: {
    pre_app_owner_id: number;
    owner_name: string | null;
    ssn_on_file: boolean;
    ssn?: string;
    ssn_last4?: string;
  }[];
  banking: {
    on_file: boolean;
    aba_routing?: string;
    account_number?: string;
    aba_routing_last4?: string;
    account_number_last4?: string;
  };
  terminal: { on_file: boolean; rp_password?: string };
};

export function SecretsStep({
  preAppId,
  owners,
  canEdit,
}: {
  preAppId: number;
  owners: PreAppOwner[];
  canEdit: boolean;
}) {
  const [status, setStatus] = useState<SecretsStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const [ssns, setSsns] = useState<Record<number, string>>({});
  const [routing, setRouting] = useState("");
  const [account, setAccount] = useState("");
  const [rpPassword, setRpPassword] = useState("");

  const refresh = useCallback(async () => {
    setLoadError(null);
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke(
      "read-pre-app-secrets",
      { body: { pre_app_id: preAppId } },
    );
    if (error) {
      setLoadError(
        "Could not read what is on file. The encryption key may not be configured.",
      );
      return;
    }
    setStatus(data as SecretsStatus);
  }, [preAppId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const entries = buildEntries({ preAppId, ssns, routing, account, rpPassword });
  const anyInvalid =
    Object.values(ssns).some((v) => v !== "" && !isSsn(v)) ||
    (routing !== "" && !isRouting(routing)) ||
    (account !== "" && !isAccount(account)) ||
    // Banking is a pair: the function requires both, so half of it is not
    // submittable. Saying so beats a 400 the rep has to interpret.
    (routing === "") !== (account === "");

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const supabase = createClient();
      const { error } = await supabase.functions.invoke(
        "submit-pre-app-secrets",
        { body: { secrets: entries } },
      );
      if (error) throw error;

      // Cleared immediately. These never live in component state longer than the
      // round trip, and are never read back from the server.
      setSsns({});
      setRouting("");
      setAccount("");
      setRpPassword("");
      setSavedAt(Date.now());
      await refresh();
    } catch (err: unknown) {
      setSaveError(
        err instanceof Error
          ? err.message
          : "Could not save. Nothing was stored.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
        These four values are encrypted before they are stored and are held in
        separate tables that no browser can read or write directly. They are not
        saved as you type — fill in what you have and press{" "}
        <strong>Encrypt &amp; save</strong>.
      </p>

      {loadError && <p className="text-sm text-destructive">{loadError}</p>}

      <fieldset className="flex flex-col gap-4">
        <legend className="font-semibold text-sm">Owner SSNs</legend>
        {owners.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Add an owner first — an SSN is stored against a specific owner.
          </p>
        ) : (
          <div className="grid gap-6 sm:grid-cols-2">
            {owners.map((owner) => {
              const onFile = status?.owners.find(
                (o) => o.pre_app_owner_id === owner.id,
              );
              return (
                <div key={owner.id} className="flex flex-col gap-2">
                  <Label>{owner.owner_name ?? `Owner #${owner.id}`}</Label>
                  <MaskedInput
                    mask={maskSsn}
                    placeholder="123-45-6789"
                    disabled={!canEdit || saving}
                    value={ssns[owner.id] ?? ""}
                    aria-invalid={Boolean(
                      ssns[owner.id] && !isSsn(ssns[owner.id]),
                    )}
                    onChange={(v) =>
                      setSsns((prev) => ({ ...prev, [owner.id]: v }))
                    }
                  />
                  <OnFile
                    label="SSN"
                    onFile={Boolean(onFile?.ssn_on_file)}
                    shown={onFile?.ssn ?? onFile?.ssn_last4}
                    tier={status?.tier}
                  />
                </div>
              );
            })}
          </div>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="font-semibold text-sm">Banking</legend>
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label>ABA routing number</Label>
            <MaskedInput
              mask={maskRouting}
              placeholder="021000021"
              disabled={!canEdit || saving}
              value={routing}
              aria-invalid={Boolean(routing && !isRouting(routing))}
              onChange={setRouting}
            />
            {routing !== "" && !isRouting(routing) && (
              <p className="text-xs text-destructive">Nine digits.</p>
            )}
            <OnFile
              label="Routing"
              onFile={Boolean(status?.banking.on_file)}
              shown={
                status?.banking.aba_routing ?? status?.banking.aba_routing_last4
              }
              tier={status?.tier}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label>Account number</Label>
            <MaskedInput
              mask={maskAccount}
              placeholder="000123456789"
              disabled={!canEdit || saving}
              value={account}
              aria-invalid={Boolean(account && !isAccount(account))}
              onChange={setAccount}
            />
            <OnFile
              label="Account"
              onFile={Boolean(status?.banking.on_file)}
              shown={
                status?.banking.account_number ??
                status?.banking.account_number_last4
              }
              tier={status?.tier}
            />
          </div>
        </div>
        {(routing === "") !== (account === "") && (
          <p className="text-xs text-warning">
            Routing and account number are stored together — enter both.
          </p>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="font-semibold text-sm">Terminal</legend>
        <div className="flex max-w-sm flex-col gap-2">
          <Label>RP password</Label>
          <Input
            type="password"
            // NOT autoComplete="off": Chrome deliberately ignores that on
            // password inputs so password managers keep working, and would offer
            // to fill the rep's own saved credential into a field that becomes a
            // merchant's terminal password. "new-password" is the value it does
            // honour, and it also stops the save-password prompt on submit.
            autoComplete="new-password"
            disabled={!canEdit || saving}
            value={rpPassword}
            onChange={(e) => setRpPassword(e.target.value)}
          />
          {/* Presence only, never a suffix — four characters of a password
              removes most of its entropy, unlike four digits of an account
              number. */}
          <p className="text-xs text-muted-foreground">
            {status?.terminal.on_file
              ? status.terminal.rp_password
                ? `On file: ${status.terminal.rp_password}`
                : "On file."
              : "Not on file."}
          </p>
        </div>
      </fieldset>

      {saveError && <p className="text-sm text-destructive">{saveError}</p>}

      {canEdit && (
        <div className="flex items-center gap-4 border-t pt-4">
          <Button
            type="button"
            disabled={saving || entries.length === 0 || anyInvalid}
            onClick={() => void save()}
          >
            {saving ? "Encrypting…" : "Encrypt & save"}
          </Button>
          {entries.length === 0 && (
            <span className="text-sm text-muted-foreground">
              Nothing new to save.
            </span>
          )}
          {savedAt && !saving && (
            <span className="text-sm text-muted-foreground">
              Saved and cleared from this page.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function OnFile({
  label,
  onFile,
  shown,
  tier,
}: {
  label: string;
  onFile: boolean;
  shown?: string;
  tier?: "full" | "last4";
}) {
  if (!onFile) {
    return <p className="text-xs text-muted-foreground">{label}: not on file.</p>;
  }
  return (
    <p className="text-xs text-muted-foreground">
      {label}: on file
      {shown ? (tier === "full" ? ` — ${shown}` : ` — ····${shown}`) : ""}.
    </p>
  );
}

/** Only fields the rep actually filled in are sent. */
function buildEntries({
  preAppId,
  ssns,
  routing,
  account,
  rpPassword,
}: {
  preAppId: number;
  ssns: Record<number, string>;
  routing: string;
  account: string;
  rpPassword: string;
}) {
  const entries: Record<string, unknown>[] = [];
  for (const [ownerId, ssn] of Object.entries(ssns)) {
    if (ssn && isSsn(ssn)) {
      entries.push({
        kind: "owner_ssn",
        pre_app_owner_id: Number(ownerId),
        ssn,
      });
    }
  }
  if (routing && account && isRouting(routing) && isAccount(account)) {
    entries.push({
      kind: "banking",
      pre_app_id: preAppId,
      aba_routing: routing,
      account_number: account,
    });
  }
  if (rpPassword) {
    entries.push({ kind: "terminal", pre_app_id: preAppId, rp_password: rpPassword });
  }
  return entries;
}
