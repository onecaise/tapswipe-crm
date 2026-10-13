import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type Fixtures,
  BUSINESS_DOCUMENTS_BUCKET,
  adminClient,
  functionsAreServed,
  invoke,
  provisionFixtures,
  teardownFixtures,
  warmFunctions,
} from "./helpers/stack";

/**
 * A failed upload-URL mint must never leave a LIVE business document behind.
 *
 * The marketing lesson (tests/live/marketing-upload-failure.test.ts) carried
 * over: business-document-file-url creates the row and writes its file_key
 * BEFORE asking Storage to sign. If signing fails and the row stays live, every
 * rep's library shows a document that answers "Object not found".
 *
 * Produced the way it happened to marketing on dev, by taking the bucket away.
 * Live files run one at a time (fileParallelism: false), and the bucket is put
 * back in `finally` exactly as migration 20261013120500 creates it.
 */

let fx: Fixtures;
const TITLE = "LIVE signing-failure business document";

beforeAll(async () => {
  if (!(await functionsAreServed())) {
    throw new Error(
      "No Edge Function runtime answering on the local stack.\n" +
        "Run `npx supabase start` and `npx supabase functions serve` first.",
    );
  }
  await warmFunctions(["business-document-file-url"]);
  fx = await provisionFixtures();
});

afterAll(async () => {
  await teardownFixtures();
});

describe("signing the upload URL fails", () => {
  it("archives the new row rather than leaving it live with a file_key", async () => {
    const admin = adminClient();

    const { error: emptyError } = await admin.storage.emptyBucket(BUSINESS_DOCUMENTS_BUCKET);
    expect(emptyError).toBeNull();
    const { error: deleteError } = await admin.storage.deleteBucket(BUSINESS_DOCUMENTS_BUCKET);
    expect(deleteError).toBeNull();

    try {
      const { status, body } = await invoke(
        "business-document-file-url",
        {
          category: "Policies",
          title: TITLE,
          file_name: "policy.txt",
          mime_type: "text/plain",
        },
        fx.tokens.admin,
      );
      expect(status).toBe(500);
      expect(String(body.error)).toMatch(/Could not create upload URL/);

      const { data: rows, error } = await admin
        .from("business_documents")
        .select("id, file_key, archived_at")
        .eq("title", TITLE);
      expect(error).toBeNull();
      expect(rows).toHaveLength(1);
      // It got as far as writing the key -- the case that would leave a live
      // dead row.
      expect(rows![0].file_key).toMatch(new RegExp(`^${rows![0].id}/`));
      expect(
        rows![0].archived_at,
        "a document whose upload URL was never minted is still live",
      ).not.toBeNull();
    } finally {
      const { error: restoreError } = await admin.storage.createBucket(
        BUSINESS_DOCUMENTS_BUCKET,
        { public: false, fileSizeLimit: 50 * 1024 * 1024 },
      );
      if (restoreError) {
        throw new Error(
          `could not restore the business-documents bucket: ${restoreError.message}`,
        );
      }
    }
  });
});
