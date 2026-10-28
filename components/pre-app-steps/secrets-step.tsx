"use client";

import { useCallback, useEffect, useId, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { edgeFunctionErrorMessage } from "@/lib/edge-functions";
import type { PreApp, PreAppOwner } from "@/lib/pre-apps";
import {
  isAccount,
  isRouting,
  isSsn,
  maskAccount,
  maskRouting,
  maskSsn,
  taxIdFormat,
} from "@/lib/masks";
import { useUnsavedChangesWarning } from "@/hooks/use-unsaved-changes-warning";
import { MaskedInput } from "@/components/masked-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * SSN, bank routing/account, the terminal RP password and the business tax ID
 * (an EIN, or an SSN when the Business step's EIN type says so).
 *
 * This step is deliberately unlike every other one:
 *
 *  - **No autosave.** These values cannot be written by supabase-js at all — the
 *    four *_secrets tables have RLS with zero policies and no grant to any
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
/**
 * Spread onto the SSN, tax ID, routing and account inputs (A2). Without them a browser
 * may offer to remember a merchant's SSN and suggest it in some later field,
 * and a phone keyboard autocorrects or capitalises what it takes for a word.
 * `numeric` brings up the digit pad; the masks still allow the dashes.
 * The RP password is NOT given these: it keeps autoComplete="new-password",
 * for the reason in the comment on that input.
 */
const SENSITIVE_NUMBER_INPUT = {
  autoComplete: "off",
  spellCheck: false,
  autoCorrect: "off",
  autoCapitalize: "off",
  inputMode: "numeric",
} as const;

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
  tax_id: {
    on_file: boolean;
    /** The STORED row's kind, which may differ from the current EIN type. */
    tax_id_type?: "EIN" | "SSN";
    tax_id?: string;
    tax_id_last4?: string;
  };
};

export function SecretsStep({
  preAppId,
  owners,
  einType,
  canEdit,
}: {
  preAppId: number;
  owners: PreAppOwner[];
  /** The Business step's choice; picks the tax ID's mask and validator. */
  einType: PreApp["ein_type"];
  canEdit: boolean;
}) {
  // Pairs each label with its input (QA-004) — none of these had an accessible name.
  const fieldId = useId();
  const [status, setStatus] = useState<SecretsStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const [ssns, setSsns] = useState<Record<number, string>>({});
  const [routing, setRouting] = useState("");
  const [account, setAccount] = useState("");
  const [rpPassword, setRpPassword] = useState("");
  const [taxId, setTaxId] = useState("");
  const taxFormat = einType ? taxIdFormat(einType) : null;

  // This step has no autosave, so typed values exist only here until Encrypt &
  // save — warn before a reload or close discards them (D-07). The values are
  // cleared on a successful save, which turns the warning off again. Never
  // persisted anywhere in the browser to "restore" them: these are SSNs and
  // bank numbers. See hooks/use-unsaved-changes-warning.ts.
  useUnsavedChangesWarning(
    Object.values(ssns).some((value) => value !== "") ||
      routing !== "" ||
      account !== "" ||
      rpPassword !== "" ||
      taxId !== "",
  );

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

  const entries = buildEntries({
    preAppId,
    ssns,
    routing,
    account,
    rpPassword,
    einType,
    taxId,
  });
  const taxIdInvalid =
    taxId !== "" && (taxFormat === null || !taxFormat.isValid(taxId));
  const anyInvalid =
    taxIdInvalid ||
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
      if (error) {
        // The function's own message (it never echoes a value), not
        // supabase-js's fixed "non-2xx" string — see lib/edge-functions.ts.
        setSaveError(
          await edgeFunctionErrorMessage(error, "Could not save. Nothing was stored."),
        );
        return;
      }

      // Cleared immediately. These never live in component state longer than the
      // round trip, and are never read back from the server.
      setSsns({});
      setRouting("");
      setAccount("");
      setRpPassword("");
      setTaxId("");
      setSavedAt(Date.now());
      await refresh();
    } catch {
      setSaveError("Could not save. Nothing was stored.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
        These values are encrypted before they are stored and are held in
        separate tables that no browser can read or write directly. They are not
        saved as you type — fill in what you have and press{" "}
        <strong>Encrypt &amp; save</strong>.
      </p>

      {loadError && <p className="text-sm text-destructive">{loadError}</p>}

      <fieldset className="flex flex-col gap-4">
        <legend className="font-semibold text-sm">Business tax ID</legend>
        {einType === null || taxFormat === null ? (
          <p className="text-sm text-muted-foreground">
            Choose the EIN type (EIN or SSN) on the Business step first — it
            decides which number goes here.
          </p>
        ) : (
          <div className="flex max-w-sm flex-col gap-2">
            <Label htmlFor={`${fieldId}-tax-id`}>
              {einType === "EIN" ? "EIN" : "SSN (business tax ID)"}
            </Label>
            <MaskedInput
              id={`${fieldId}-tax-id`}
              {...SENSITIVE_NUMBER_INPUT}
              mask={taxFormat.mask}
              placeholder={taxFormat.placeholder}
              disabled={!canEdit || saving}
              value={taxId}
              aria-invalid={taxIdInvalid}
              onChange={setTaxId}
            />
            {taxIdInvalid && (
              <p className="text-xs text-destructive">
                {einType === "EIN"
                  ? "Nine digits, as 12-3456789, not starting 00."
                  : "Nine digits, as 123-45-6789, in a range the SSA issues."}
              </p>
            )}
            <TaxIdOnFile status={status} einType={einType} />
          </div>
        )}
      </fieldset>

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
                  <Label htmlFor={`${fieldId}-ssn-${owner.id}`}>
                    {owner.owner_name ?? `Owner #${owner.id}`}
                  </Label>
                  <MaskedInput
                    id={`${fieldId}-ssn-${owner.id}`}
                    {...SENSITIVE_NUMBER_INPUT}
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
                  {/* The shape alone is not enough since phase 4: isSsn also
                      refuses numbers the SSA never issues (000-00-0000). */}
                  {ssns[owner.id] && !isSsn(ssns[owner.id]) && (
                    <p className="text-xs text-destructive">
                      Nine digits, as 123-45-6789, in a range the SSA issues.
                    </p>
                  )}
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
            <Label htmlFor={`${fieldId}-routing`}>ABA routing number</Label>
            <MaskedInput
              id={`${fieldId}-routing`}
              {...SENSITIVE_NUMBER_INPUT}
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
            <Label htmlFor={`${fieldId}-account`}>Account number</Label>
            <MaskedInput
              id={`${fieldId}-account`}
              {...SENSITIVE_NUMBER_INPUT}
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
          <Label htmlFor={`${fieldId}-rp-password`}>RP password</Label>
          <Input
            id={`${fieldId}-rp-password`}
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

/**
 * What is on file for the tax ID, judged against the CURRENT EIN type. A stored
 * number of the other kind does not count (submit_pre_app() refuses it), so it
 * is shown as needing re-entry rather than as on file.
 */
function TaxIdOnFile({
  status,
  einType,
}: {
  status: SecretsStatus | null;
  einType: "EIN" | "SSN";
}) {
  const stored = status?.tax_id;
  if (stored?.on_file && stored.tax_id_type && stored.tax_id_type !== einType) {
    return (
      <p className="text-xs text-warning">
        The tax ID on file is an {stored.tax_id_type}, but EIN type says{" "}
        {einType}. Enter the {einType}.
      </p>
    );
  }
  return (
    <OnFile
      label={einType}
      onFile={Boolean(stored?.on_file)}
      shown={stored?.tax_id ?? stored?.tax_id_last4}
      tier={status?.tier}
    />
  );
}

/** Only fields the rep actually filled in are sent. */
function buildEntries({
  preAppId,
  ssns,
  routing,
  account,
  rpPassword,
  einType,
  taxId,
}: {
  preAppId: number;
  ssns: Record<number, string>;
  routing: string;
  account: string;
  rpPassword: string;
  einType: PreApp["ein_type"];
  taxId: string;
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
  // The kind is the CURRENT EIN type; the function refuses any other.
  if (einType && taxId && taxIdFormat(einType).isValid(taxId)) {
    entries.push({
      kind: "tax_id",
      pre_app_id: preAppId,
      tax_id_type: einType,
      tax_id: taxId,
    });
  }
  return entries;
}
