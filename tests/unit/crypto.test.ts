import { beforeEach, describe, expect, it } from "vitest";

import {
  CiphertextError,
  IV_BYTES,
  KEY_BYTES,
  SecretsKeyError,
  TAG_BYTES,
  bytesToPgHex,
  cachedSecretsKey,
  decryptSecret,
  encryptSecret,
  importSecretsKey,
  last4,
  pgHexToBytes,
  resetKeyCache,
  secretAad,
} from "../../supabase/functions/_shared/crypto";

/**
 * The encryption core, tested hermetically.
 *
 * This is only possible because _shared/crypto.ts is Deno-free — it uses Web
 * Crypto and TextEncoder, both of which Node provides, and takes the key as an
 * argument rather than reading Deno.env. So the tamper cases and the
 * key-length refusal run in `npm test` instead of needing a live stack, which
 * matters: "refuses a wrong-length key" is a branch you cannot reach over HTTP
 * without restarting the runtime with a bad environment.
 *
 * Imported by relative path, not the `@/` alias: tsconfig excludes `supabase/`,
 * so the alias does not reach it.
 */

const KEY_B64 = Buffer.from(new Uint8Array(KEY_BYTES).fill(7)).toString("base64");
const OTHER_KEY_B64 = Buffer.from(
  new Uint8Array(KEY_BYTES).fill(9),
).toString("base64");

beforeEach(() => {
  resetKeyCache();
});

describe("key import", () => {
  it("accepts a 32-byte base64 key", async () => {
    await expect(importSecretsKey(KEY_B64)).resolves.toBeDefined();
  });

  it("refuses a missing key", async () => {
    await expect(importSecretsKey(undefined)).rejects.toThrow(SecretsKeyError);
    await expect(importSecretsKey("")).rejects.toThrow(SecretsKeyError);
    await expect(importSecretsKey("   ")).rejects.toThrow(SecretsKeyError);
  });

  it("refuses a key of the wrong length, naming the length", async () => {
    // The message has to say what was wrong, or a deployment with a 16-byte key
    // looks like a generic failure.
    const short = Buffer.from(new Uint8Array(16).fill(1)).toString("base64");
    await expect(importSecretsKey(short)).rejects.toThrow(/16 bytes/);
    await expect(importSecretsKey(short)).rejects.toThrow(SecretsKeyError);
  });

  it("refuses a key that is not base64", async () => {
    await expect(importSecretsKey("not base64 !!!")).rejects.toThrow(
      SecretsKeyError,
    );
  });

  it("caches success but not failure", async () => {
    const first = await cachedSecretsKey(KEY_B64);
    const second = await cachedSecretsKey(KEY_B64);
    expect(second).toBe(first);

    resetKeyCache();
    await expect(cachedSecretsKey("bad")).rejects.toThrow(SecretsKeyError);
    // A failure must not be remembered — fixing the environment and retrying
    // should work without a restart.
    await expect(cachedSecretsKey(KEY_B64)).resolves.toBeDefined();
  });
});

describe("round trip", () => {
  it("recovers the plaintext", async () => {
    const key = await importSecretsKey(KEY_B64);
    for (const value of ["123-45-6789", "021000021", "000123456789"]) {
      const stored = await encryptSecret(key, value);
      expect(await decryptSecret(key, stored)).toBe(value);
    }
  });

  it("handles unicode and a 17-digit account number", async () => {
    const key = await importSecretsKey(KEY_B64);
    for (const value of ["café ünïcode ✓", "12345678901234567"]) {
      const stored = await encryptSecret(key, value);
      expect(await decryptSecret(key, stored)).toBe(value);
    }
  });

  it("produces the documented layout and wire format", async () => {
    const key = await importSecretsKey(KEY_B64);
    const value = "123-45-6789";
    const stored = await encryptSecret(key, value);

    expect(stored).toMatch(/^\\x[0-9a-f]+$/);
    // 12-byte IV || ciphertext || 16-byte tag. AES-GCM ciphertext is the same
    // length as the plaintext.
    expect(pgHexToBytes(stored)).toHaveLength(
      IV_BYTES + Buffer.byteLength(value, "utf8") + TAG_BYTES,
    );
  });

  it("never produces the same ciphertext twice", async () => {
    // Catches a hardcoded IV, which is the one catastrophic AES-GCM mistake:
    // reusing a nonce under the same key leaks the keystream.
    const key = await importSecretsKey(KEY_B64);
    const a = await encryptSecret(key, "123-45-6789");
    const b = await encryptSecret(key, "123-45-6789");
    expect(a).not.toBe(b);
  });

  it("does not leave the plaintext visible in the payload", async () => {
    const key = await importSecretsKey(KEY_B64);
    const stored = await encryptSecret(key, "123456789");
    expect(stored).not.toContain("123456789");
  });
});

describe("tamper detection", () => {
  const corrupt = (stored: string, index: number) => {
    const bytes = pgHexToBytes(stored);
    bytes[index] = bytes[index] ^ 0xff;
    return bytesToPgHex(bytes);
  };

  it("rejects a flipped ciphertext byte", async () => {
    const key = await importSecretsKey(KEY_B64);
    const stored = await encryptSecret(key, "123-45-6789");
    await expect(decryptSecret(key, corrupt(stored, IV_BYTES + 1))).rejects.toThrow();
  });

  it("rejects a flipped IV byte", async () => {
    const key = await importSecretsKey(KEY_B64);
    const stored = await encryptSecret(key, "123-45-6789");
    await expect(decryptSecret(key, corrupt(stored, 0))).rejects.toThrow();
  });

  it("rejects a truncated tag", async () => {
    const key = await importSecretsKey(KEY_B64);
    const stored = await encryptSecret(key, "123-45-6789");
    const bytes = pgHexToBytes(stored);
    await expect(
      decryptSecret(key, bytesToPgHex(bytes.slice(0, bytes.length - 4))),
    ).rejects.toThrow();
  });

  it("rejects a payload too short to be well-formed", async () => {
    const key = await importSecretsKey(KEY_B64);
    await expect(decryptSecret(key, "\\x0011")).rejects.toThrow(CiphertextError);
  });

  it("rejects the wrong key", async () => {
    const key = await importSecretsKey(KEY_B64);
    const other = await importSecretsKey(OTHER_KEY_B64);
    const stored = await encryptSecret(key, "123-45-6789");
    await expect(decryptSecret(other, stored)).rejects.toThrow();
  });
});

describe("row binding via additional data", () => {
  it("round-trips under the same aad", async () => {
    const key = await importSecretsKey(KEY_B64);
    const aad = secretAad("pre_app_banking_secrets", "account_number_encrypted", 7);
    const stored = await encryptSecret(key, "000123456789", aad);
    expect(await decryptSecret(key, stored, aad)).toBe("000123456789");
  });

  it("refuses a value moved to another row", async () => {
    // The whole point: without aad, anyone who can write to the database could
    // copy agent A's account_number_encrypted onto agent B's row and read the
    // plaintext back through read-pre-app-secrets.
    const key = await importSecretsKey(KEY_B64);
    const stored = await encryptSecret(
      key,
      "000123456789",
      secretAad("pre_app_banking_secrets", "account_number_encrypted", 7),
    );
    await expect(
      decryptSecret(
        key,
        stored,
        secretAad("pre_app_banking_secrets", "account_number_encrypted", 8),
      ),
    ).rejects.toThrow();
  });

  it("refuses a value moved to another column of the same row", async () => {
    const key = await importSecretsKey(KEY_B64);
    const stored = await encryptSecret(
      key,
      "021000021",
      secretAad("pre_app_banking_secrets", "aba_routing_encrypted", 7),
    );
    await expect(
      decryptSecret(
        key,
        stored,
        secretAad("pre_app_banking_secrets", "account_number_encrypted", 7),
      ),
    ).rejects.toThrow();
  });
});

describe("bytea wire encoding", () => {
  it("round-trips bytes through the hex form", () => {
    const bytes = new Uint8Array([0, 1, 255, 16]);
    expect(bytesToPgHex(bytes)).toBe("\\x0001ff10");
    expect([...pgHexToBytes("\\x0001ff10")]).toEqual([0, 1, 255, 16]);
  });

  it("rejects a base64 payload, which Postgres would silently accept", () => {
    // bytea_in treats a base64 string as the escape format and stores its
    // literal ASCII with no error — measured, "AQL/" becomes 41514c2f. That is
    // undetectable data destruction, so this parser is the tripwire.
    expect(() => pgHexToBytes("AQL/")).toThrow(CiphertextError);
  });

  it("rejects a missing prefix, odd length and non-hex characters", () => {
    expect(() => pgHexToBytes("0001ff10")).toThrow(CiphertextError);
    expect(() => pgHexToBytes("\\x001")).toThrow(CiphertextError);
    expect(() => pgHexToBytes("\\xzzzz")).toThrow(CiphertextError);
  });

  it("accepts uppercase hex from Postgres and normalises on the way out", () => {
    expect([...pgHexToBytes("\\x00FF")]).toEqual([0, 255]);
    expect(bytesToPgHex(new Uint8Array([0, 255]))).toBe("\\x00ff");
  });
});

describe("last4", () => {
  it("takes the final four characters", () => {
    expect(last4("123456789")).toBe("6789");
    expect(last4("1234")).toBe("1234");
  });

  it("returns empty rather than a partial value when too short", () => {
    expect(last4("123")).toBe("");
    expect(last4("")).toBe("");
  });
});
