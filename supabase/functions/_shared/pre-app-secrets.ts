// Request validation and authorization helpers for the two secrets functions.
//
// Dependency-free by design, the same rule _shared/documents.ts follows: no zod,
// no `npm:`/`jsr:` specifier, nothing that needs an import-map entry. That keeps
// the deploy bundle simple and means this file can be read from Node too.
//
// The format rules here are DUPLICATED from lib/masks.ts, because tsconfig
// excludes `supabase/` and Deno cannot import from `lib/`. That duplication is
// the same trade _shared/documents.ts makes for DOCUMENT_OWNER_TYPES — and since
// TypeScript cannot see the pair, the guarantee is behavioural:
// tests/live/pre-app-secrets.test.ts POSTs each value the client-side validator
// rejects and asserts a 400. If you change a rule in lib/masks.ts, change it
// here and that test is what catches you having forgotten.

export type OwnerSsnEntry = {
  kind: "owner_ssn";
  pre_app_owner_id: number;
  ssn: string;
};

export type BankingEntry = {
  kind: "banking";
  pre_app_id: number;
  aba_routing: string;
  account_number: string;
};

export type TerminalEntry = {
  kind: "terminal";
  pre_app_id: number;
  rp_password: string;
};

export type SecretEntry = OwnerSsnEntry | BankingEntry | TerminalEntry;

export const isPositiveInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

export const isSsn = (value: unknown): value is string =>
  typeof value === "string" && /^\d{3}-\d{2}-\d{4}$/.test(value);

export const isAccountNumber = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4,17}$/.test(value);

export const isRpPassword = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 128;

/**
 * ABA routing number: nine digits AND the 3-7-1 weighted mod-10 check digit.
 *
 * `3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9) ≡ 0 (mod 10)`. This is NOT Luhn —
 * 011401533 (KeyBank) is ABA-valid and Luhn-invalid, so reaching for Luhn here
 * would reject real routing numbers. Checking at all matters because once the
 * value is encrypted nobody can eyeball it again.
 */
export function isRoutingNumber(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{9}$/.test(value)) return false;
  const n = [...value].map(Number);
  const sum =
    3 * (n[0] + n[3] + n[6]) + 7 * (n[1] + n[4] + n[7]) + (n[2] + n[5] + n[8]);
  return sum % 10 === 0;
}

export type ParseResult =
  | { ok: true; entries: SecretEntry[] }
  | { ok: false; error: string };

/**
 * Validates the request body.
 *
 * A discriminated array rather than one flat object, because the three secrets
 * hang off two different parents: an SSN belongs to a `pre_app_owners` row while
 * banking and terminal belong to the `pre_apps` row. A flat body would let a
 * caller pair an owner id from one pre-app with a pre-app id from another, and
 * the function would have to notice. This shape makes each entry state its own
 * parent, and the handler then requires every entry to resolve to the same
 * pre-app.
 *
 * Error messages deliberately never echo a submitted value — the entire point of
 * this endpoint is that SSNs and account numbers are not logged or reflected.
 */
export function parseSecretsBody(body: unknown): ParseResult {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Body must be a JSON object" };
  }
  const secrets = (body as { secrets?: unknown }).secrets;
  if (!Array.isArray(secrets) || secrets.length === 0) {
    return { ok: false, error: "secrets must be a non-empty array" };
  }
  if (secrets.length > 20) {
    return { ok: false, error: "Too many secrets in one request" };
  }

  const entries: SecretEntry[] = [];
  for (const raw of secrets) {
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, error: "Each secret must be an object" };
    }
    const entry = raw as Record<string, unknown>;

    switch (entry.kind) {
      case "owner_ssn": {
        if (!isPositiveInt(entry.pre_app_owner_id)) {
          return { ok: false, error: "pre_app_owner_id must be a positive integer" };
        }
        if (!isSsn(entry.ssn)) {
          return { ok: false, error: "ssn must be formatted 123-45-6789" };
        }
        entries.push({
          kind: "owner_ssn",
          pre_app_owner_id: entry.pre_app_owner_id,
          ssn: entry.ssn,
        });
        break;
      }
      case "banking": {
        if (!isPositiveInt(entry.pre_app_id)) {
          return { ok: false, error: "pre_app_id must be a positive integer" };
        }
        if (!isRoutingNumber(entry.aba_routing)) {
          return {
            ok: false,
            error: "aba_routing must be nine digits and pass its checksum",
          };
        }
        if (!isAccountNumber(entry.account_number)) {
          return { ok: false, error: "account_number must be 4 to 17 digits" };
        }
        entries.push({
          kind: "banking",
          pre_app_id: entry.pre_app_id,
          aba_routing: entry.aba_routing,
          account_number: entry.account_number,
        });
        break;
      }
      case "terminal": {
        if (!isPositiveInt(entry.pre_app_id)) {
          return { ok: false, error: "pre_app_id must be a positive integer" };
        }
        if (!isRpPassword(entry.rp_password)) {
          return { ok: false, error: "rp_password must be 1 to 128 characters" };
        }
        entries.push({
          kind: "terminal",
          pre_app_id: entry.pre_app_id,
          rp_password: entry.rp_password,
        });
        break;
      }
      default:
        return { ok: false, error: "Unknown secret kind" };
    }
  }

  return { ok: true, entries };
}

type RpcClient = {
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};

/**
 * Whether the caller is an admin, asked through the CALLER-SCOPED client.
 *
 * Never inferred from comparing the caller to the record's `agent_id`: an admin
 * can also be the owning agent, and that inference would silently downgrade them
 * to the masked tier. And never asked through `supabaseAdmin`, which has no
 * `auth.uid()` and would always answer false — the same trap `callerIsActive`
 * documents.
 */
export async function callerIsAdmin(supabase: RpcClient): Promise<boolean> {
  const { data, error } = await supabase.rpc("is_admin");
  if (error) return false;
  return data === true;
}
