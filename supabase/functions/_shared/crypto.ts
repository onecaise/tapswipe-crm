// AES-256-GCM for the three *_secrets tables.
//
// Deliberately Deno-free: only Web Crypto and TextEncoder/TextDecoder, all of
// which Node also provides as globals. That is what lets `npm test` exercise the
// round trip, the tamper cases and the key-length refusal hermetically instead
// of only over HTTP. The one Deno-specific line — reading the secret out of the
// environment — lives in secrets-env.ts, which Node never imports.
//
// Same instinct as _shared/documents.ts, which "takes clients as arguments
// rather than importing @supabase/server", pushed one step further: this takes
// the key material as an argument.

export const KEY_ENV_VAR = "PRE_APP_SECRETS_KEY";
export const KEY_BYTES = 32; // AES-256
export const IV_BYTES = 12; // the standard GCM nonce length
export const TAG_BYTES = 16; // 128-bit auth tag

/** The key is missing or the wrong shape — a configuration problem. */
export class SecretsKeyError extends Error {}

/** A stored value is not a well-formed payload — a data problem. */
export class CiphertextError extends Error {}

/**
 * Imports the base64-encoded key.
 *
 * Throws rather than ever returning a degraded key: a function that silently
 * encrypted under a truncated or wrong-length key would produce ciphertext
 * nobody can decrypt later, and the failure would surface months afterwards as
 * an unexplainable OperationError.
 *
 * `extractable: false`, so the key cannot be read back out of the isolate even
 * by code running inside it.
 */
export async function importSecretsKey(
  base64Key: string | undefined,
): Promise<CryptoKey> {
  if (!base64Key || base64Key.trim() === "") {
    throw new SecretsKeyError(
      `${KEY_ENV_VAR} is not set. Generate one with \`openssl rand -base64 32\` ` +
        `and set it with \`npx supabase secrets set\` (or in supabase/functions/.env for local serve).`,
    );
  }

  // An ArrayBuffer rather than a Uint8Array, so this satisfies `BufferSource`
  // under both runtimes' lib types. tests/unit/crypto.test.ts imports this file,
  // which pulls it into the Node TS program even though tsconfig excludes
  // `supabase/` as a root — so it has to type-check against Node's stricter
  // ArrayBufferLike variance as well as Deno's.
  let raw: ArrayBuffer;
  try {
    raw = base64ToBuffer(base64Key.trim());
  } catch {
    throw new SecretsKeyError(`${KEY_ENV_VAR} is not valid base64.`);
  }

  if (raw.byteLength !== KEY_BYTES) {
    throw new SecretsKeyError(
      `${KEY_ENV_VAR} decoded to ${raw.byteLength} bytes; AES-256 needs exactly ${KEY_BYTES}.`,
    );
  }

  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

let cached: Promise<CryptoKey> | null = null;

/**
 * Memoised key import.
 *
 * Caches only success. A failure is re-thrown on every call rather than
 * remembered, so fixing the environment and retrying works without a restart.
 */
export function cachedSecretsKey(
  base64Key: string | undefined,
): Promise<CryptoKey> {
  if (!cached) {
    const attempt = importSecretsKey(base64Key);
    cached = attempt;
    attempt.catch(() => {
      cached = null;
    });
  }
  return cached;
}

/** Test seam: forget the memoised key. */
export function resetKeyCache(): void {
  cached = null;
}

/**
 * Encrypts to the exact bytea payload, returned in PostgREST's wire form.
 *
 * Layout is `12-byte IV || ciphertext || 16-byte tag`. Note that WebCrypto's
 * AES-GCM output *already* ends with the tag — there is nothing to slice off and
 * re-append, and doing so would corrupt it.
 *
 * `aad` binds the ciphertext to the row it belongs to. Without it, anyone able
 * to write to the database could copy one pre-app's `account_number_encrypted`
 * onto another's row and read the plaintext back through read-pre-app-secrets,
 * because the ciphertext says nothing about where it lives. With it, that swap
 * fails the tag check. It costs nothing at write time and cannot be retrofitted
 * once real ciphertext exists.
 */
export async function encryptSecret(
  key: CryptoKey,
  plaintext: string,
  aad?: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      tagLength: TAG_BYTES * 8,
      ...(aad ? { additionalData: new TextEncoder().encode(aad) } : {}),
    },
    key,
    new TextEncoder().encode(plaintext),
  );

  const payload = new Uint8Array(IV_BYTES + encrypted.byteLength);
  payload.set(iv, 0);
  payload.set(new Uint8Array(encrypted), IV_BYTES);
  return bytesToPgHex(payload);
}

/** The inverse. Throws CiphertextError on a malformed payload; a failed tag
 *  check surfaces as WebCrypto's own OperationError. */
export async function decryptSecret(
  key: CryptoKey,
  stored: string,
  aad?: string,
): Promise<string> {
  const payload = pgHexToBytes(stored);
  if (payload.length < IV_BYTES + TAG_BYTES) {
    throw new CiphertextError(
      `Stored value is ${payload.length} bytes, too short to be IV + ciphertext + tag.`,
    );
  }

  const iv = payload.slice(0, IV_BYTES);
  const body = payload.slice(IV_BYTES);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv,
      tagLength: TAG_BYTES * 8,
      ...(aad ? { additionalData: new TextEncoder().encode(aad) } : {}),
    },
    key,
    body,
  );
  return new TextDecoder().decode(plaintext);
}

/** `\x` + lowercase hex — the only encoding PostgREST accepts for bytea. */
export function bytesToPgHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `\\x${hex}`;
}

/**
 * Parses PostgREST's bytea representation.
 *
 * Strict on purpose, and this is the important tripwire: Postgres's `bytea_in`
 * accepts a base64 string as the *escape* format and silently stores its literal
 * ASCII bytes with no error at all — measured, `"AQL/"` becomes the four bytes
 * 41514c2f. A base64 bug in this path is therefore undetectable data
 * destruction, discovered much later as a decrypt failure. Rejecting anything
 * that is not `\x`-prefixed hex is what catches it at the boundary.
 */
export function pgHexToBytes(value: string): Uint8Array {
  if (typeof value !== "string" || !value.startsWith("\\x")) {
    throw new CiphertextError(
      "Stored value is not in PostgREST's \\x-hex bytea form. A base64 payload " +
        "would be accepted by Postgres as literal ASCII, so this is refused.",
    );
  }
  const hex = value.slice(2);
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new CiphertextError("Stored value is not valid hex.");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** The last four characters, for the agent-tier read. "" if shorter. */
export function last4(value: string): string {
  return value.length >= 4 ? value.slice(-4) : "";
}

/** The row-binding string used as AES-GCM additional data. */
export function secretAad(
  table:
    | "pre_app_owner_secrets"
    | "pre_app_banking_secrets"
    | "pre_app_terminal_secrets",
  column: string,
  parentId: number,
): string {
  return `${table}:${column}:${parentId}`;
}

function base64ToBuffer(base64: string): ArrayBuffer {
  // atob exists in both Deno and Node 16+.
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return buffer;
}
