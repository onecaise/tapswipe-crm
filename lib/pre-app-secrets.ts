/**
 * The browser's side of read-pre-app-secrets (phase 5 of
 * docs/design/intake-and-reports.md, §1.E and A24).
 *
 * Two requests, two shapes:
 *
 *  - the DEFAULT read answers every caller, admin included, with the last four
 *    of each number and presence only for the RP password (`SecretsStatus`);
 *  - a REVEAL names one field and returns its full value (`RevealedSecret`).
 *    Admin only; record_pre_app_secret_reveal() audits it and limits it to 30
 *    an hour.
 *
 * A revealed value lives only in the React state of the component that asked
 * for it (components/pre-app-sensitive-data.tsx). Nothing here stores it, and
 * nothing may: not a URL, not localStorage or sessionStorage, not the wizard's
 * autosave, not a server render, not a log line.
 */

/** Must match REVEAL_FIELDS in supabase/functions/_shared/pre-app-secrets.ts. */
export const REVEAL_FIELDS = [
  "owner_ssn",
  "aba_routing",
  "account_number",
  "rp_password",
  "tax_id",
] as const;
export type RevealField = (typeof REVEAL_FIELDS)[number];

export type RevealTarget =
  | { field: "owner_ssn"; preAppOwnerId: number }
  | { field: Exclude<RevealField, "owner_ssn"> };

/** What the default read returns: never a full value, for anyone. */
export type SecretsStatus = {
  tier: "last4";
  owners: {
    pre_app_owner_id: number;
    owner_name: string | null;
    ssn_on_file: boolean;
    ssn_last4?: string;
  }[];
  banking: {
    on_file: boolean;
    aba_routing_last4?: string;
    account_number_last4?: string;
  };
  terminal: { on_file: boolean };
  tax_id: {
    on_file: boolean;
    /** The STORED row's kind, which may differ from the current EIN type. */
    tax_id_type?: "EIN" | "SSN";
    tax_id_last4?: string;
  };
};

export type RevealedSecret = {
  field: RevealField;
  pre_app_owner_id?: number;
  tax_id_type?: "EIN" | "SSN";
  value: string;
};

/**
 * How long a revealed value stays on screen before it is masked again: 30
 * seconds, enough to read a number into a processor's portal. It is also
 * masked at once on navigation, when the tab is hidden, on pagehide and
 * before printing.
 */
export const REVEAL_TIMEOUT_MS = 30_000;

/** One key per revealable field, for the component's state map. */
export function revealKey(target: RevealTarget): string {
  return target.field === "owner_ssn"
    ? `owner_ssn:${target.preAppOwnerId}`
    : target.field;
}

/** The request body for one reveal. POSTed, so nothing lands in a URL. */
export function revealBody(
  preAppId: number,
  target: RevealTarget,
): Record<string, unknown> {
  return {
    pre_app_id: preAppId,
    reveal:
      target.field === "owner_ssn"
        ? { field: "owner_ssn", pre_app_owner_id: target.preAppOwnerId }
        : { field: target.field },
  };
}

/** The masked form every screen and every print shows: "····1234". */
export function maskedLast4(last4: string | undefined): string {
  return last4 ? `····${last4}` : "····";
}
