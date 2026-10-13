// What happens to real FILES in the business-documents bucket, over real
// HTTP against the local stack (`supabase start` + `supabase functions serve`).
//
// Run with:  npm run test:live
//
// tests/live/business-documents.test.ts covers who may do what. This file
// covers the bytes: how long a signed link lives, what the bucket itself
// refuses, and what an awkward file name turns into. These replace the file
// edge cases tests/live/document-lifecycle.test.ts had for the legacy bucket.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type Fixtures,
  BUSINESS_DOCUMENTS_BUCKET,
  MAX_DOCUMENT_BYTES,
  adminClient,
  functionsAreServed,
  invoke,
  provisionFixtures,
  teardownFixtures,
  toReachableUrl,
  warmFunctions,
} from "./helpers/stack";

const FN = "business-document-file-url";

let fx: Fixtures;

beforeAll(async () => {
  if (!(await functionsAreServed())) {
    throw new Error(
      "No Edge Function runtime answering on the local stack.\n" +
        "Run `npx supabase start` and `npx supabase functions serve` first.",
    );
  }
  await warmFunctions([FN]);
  fx = await provisionFixtures();
});

afterAll(async () => {
  // Belt and braces: the limit tests restore in `finally`, but a bucket left at
  // 1 KiB would fail every later upload in the run for an unrelated reason.
  await adminClient().storage.updateBucket(BUSINESS_DOCUMENTS_BUCKET, {
    public: false,
    fileSizeLimit: MAX_DOCUMENT_BYTES,
  });
  await teardownFixtures();
});

type Minted = {
  documentId: number;
  fileKey: string;
  signedUrl: string;
  token: string;
};

/** Mints an upload as the admin. */
async function mint(fileName: string, mimeType = "text/plain"): Promise<Minted> {
  const { status, body, raw } = await invoke(
    FN,
    { category: "Live files", title: `Live ${fileName}`.slice(0, 120), file_name: fileName, mime_type: mimeType },
    fx.tokens.admin,
  );
  expect(status, raw).toBe(200);
  return {
    documentId: body.document_id as number,
    fileKey: body.fileKey as string,
    signedUrl: body.signedUrl as string,
    token: body.token as string,
  };
}

/** PUTs bytes to a minted upload URL, as the browser's uploadToSignedUrl does. */
async function put(minted: Minted, body: BodyInit, mimeType = "text/plain"): Promise<Response> {
  return fetch(toReachableUrl(minted.signedUrl), {
    method: "PUT",
    headers: {
      "Content-Type": mimeType,
      Authorization: `Bearer ${minted.token}`,
      "x-upsert": "true",
    },
    body,
  });
}

/** Signs a read as `token` and fetches it. */
async function read(documentId: number, token: string, download = false) {
  const { status, body, raw } = await invoke(FN, { document_id: documentId, download }, token);
  expect(status, raw).toBe(200);
  const response = await fetch(toReachableUrl(body.signedUrl as string));
  return { signedUrl: body.signedUrl as string, response };
}

/** The JWT payload carried in a signed URL's `token` query parameter. */
function tokenClaims(signedUrl: string): Record<string, unknown> {
  const jwt = new URL(signedUrl).searchParams.get("token");
  expect(jwt, "signed URL carries no token").toBeTruthy();
  const payload = jwt!.split(".")[1];
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

/** Runs `body` with the bucket's limit lowered to `bytes`, restoring it after. */
async function withBucketLimit(bytes: number, body: () => Promise<void>): Promise<void> {
  const admin = adminClient();
  const { error } = await admin.storage.updateBucket(BUSINESS_DOCUMENTS_BUCKET, {
    public: false,
    fileSizeLimit: bytes,
  });
  expect(error).toBeNull();
  try {
    await body();
  } finally {
    const { error: restoreError } = await admin.storage.updateBucket(BUSINESS_DOCUMENTS_BUCKET, {
      public: false,
      fileSizeLimit: MAX_DOCUMENT_BYTES,
    });
    if (restoreError) throw new Error(`could not restore the bucket limit: ${restoreError.message}`);
  }
}

describe("signed download URLs expire", () => {
  it("signs reads for about sixty seconds, inline and as a download", async () => {
    // Decoded, not waited out. A leaked link should not be a lasting grant,
    // and SIGNED_URL_TTL_SECONDS is the only thing deciding that.
    const minted = await mint("ttl.txt");
    expect((await put(minted, "ttl bytes")).ok).toBe(true);

    for (const download of [false, true]) {
      const { signedUrl } = await read(minted.documentId, fx.tokens.owner, download);
      const claims = tokenClaims(signedUrl);
      const ttl = Number(claims.exp) - Number(claims.iat);
      console.log(`  ttl (download=${download}) -> ${ttl}s`);
      expect(ttl).toBeGreaterThanOrEqual(55);
      expect(ttl).toBeLessThanOrEqual(65);
      // And it is a token for THIS object, not a bucket-wide grant.
      expect(String(claims.url)).toBe(`${BUSINESS_DOCUMENTS_BUCKET}/${minted.fileKey}`);
    }
  });
});

describe("what the bucket accepts and refuses", () => {
  it("stores and returns a zero-byte file (which is why the browser refuses one)", async () => {
    // Server behaviour, pinned: nothing below the browser refuses an empty
    // file. businessDocumentUploadProblem() is the only thing that does, and
    // e2e/business-documents.spec.ts asserts it on the form.
    const minted = await mint("empty.txt");
    expect((await put(minted, new Uint8Array(0))).ok).toBe(true);
    const { response } = await read(minted.documentId, fx.tokens.owner);
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  it("refuses a file over the bucket's limit, and accepts one just under it", async () => {
    // The per-bucket file_size_limit is the real ceiling (config.toml's is
    // not). Lowered to 1 KiB here so the boundary is cheap to cross.
    const LIMIT = 1024;
    await withBucketLimit(LIMIT, async () => {
      const over = await mint("over.bin", "application/octet-stream");
      const overPut = await put(over, new Uint8Array(LIMIT + 1), "application/octet-stream");
      console.log(`  ${LIMIT + 1} bytes -> ${overPut.status}`);
      expect(overPut.ok).toBe(false);
      expect([400, 413]).toContain(overPut.status);

      const under = await mint("under.bin", "application/octet-stream");
      const underPut = await put(under, new Uint8Array(LIMIT - 1), "application/octet-stream");
      console.log(`  ${LIMIT - 1} bytes -> ${underPut.status}`);
      expect(underPut.ok).toBe(true);
      const { response } = await read(under.documentId, fx.tokens.owner);
      expect((await response.arrayBuffer()).byteLength).toBe(LIMIT - 1);
    });

    // And the real limit is back.
    const { data } = await adminClient().storage.getBucket(BUSINESS_DOCUMENTS_BUCKET);
    expect(data?.file_size_limit).toBe(MAX_DOCUMENT_BYTES);
  });
});

describe("file names", () => {
  it("keeps two uploads with the same file name apart", async () => {
    const first = await mint("policy.txt");
    const second = await mint("policy.txt");
    expect(first.fileKey).not.toBe(second.fileKey);
    expect((await put(first, "first bytes")).ok).toBe(true);
    expect((await put(second, "second bytes")).ok).toBe(true);

    expect(await (await read(first.documentId, fx.tokens.owner)).response.text()).toBe("first bytes");
    expect(await (await read(second.documentId, fx.tokens.owner)).response.text()).toBe("second bytes");
  });

  const AWKWARD: [string, string, string][] = [
    // [label, as uploaded, expected stored name]
    ["spaces", "Chargeback policy v2.txt", "Chargeback_policy_v2.txt"],
    ["unicode", "Política de reembolsos ñ.txt", "Pol_tica_de_reembolsos__.txt"],
    ["path-like", "../x", "_x"],
    ["path-like with a folder", "../marketing/secret.txt", "_marketing_secret.txt"],
    ["very long", `${"a".repeat(300)}.txt`, "a".repeat(120)],
  ];

  for (const [label, uploaded, stored] of AWKWARD) {
    it(`stores a ${label} name under the document's own prefix, and serves it back`, async () => {
      const minted = await mint(uploaded);
      // One segment under {id}/, so nothing can land outside the document's
      // prefix -- the CHECK and fileKeyMatchesBusinessDocument() both rely on it.
      expect(minted.fileKey).toBe(`${minted.documentId}/${stored}`);
      expect((await put(minted, `bytes for ${label}`)).ok).toBe(true);

      const { data: row } = await adminClient()
        .from("business_documents")
        .select("file_name, file_key")
        .eq("id", minted.documentId)
        .single();
      expect(row).toEqual({ file_name: stored, file_key: minted.fileKey });

      const { response } = await read(minted.documentId, fx.tokens.owner, true);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(`bytes for ${label}`);
      // Storage appends an RFC 5987 `filename*=UTF-8''...` parameter after the
      // plain one, so the plain one is matched exactly up to its terminator.
      const escaped = stored.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(response.headers.get("content-disposition")).toMatch(
        new RegExp(`^attachment; filename=${escaped}(;|$)`),
      );
    });
  }

  it("left nothing outside the per-document prefixes", async () => {
    // A traversal that escaped would show up as a top-level entry that is not
    // a numeric document id.
    const { data } = await adminClient()
      .storage.from(BUSINESS_DOCUMENTS_BUCKET)
      .list("", { limit: 1000 });
    const stray = (data ?? []).filter((entry) => !/^[0-9]+$/.test(entry.name));
    expect(stray.map((entry) => entry.name)).toEqual([]);
  });
});
