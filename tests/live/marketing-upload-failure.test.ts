import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type Fixtures,
  MARKETING_BUCKET,
  adminClient,
  functionsAreServed,
  invoke,
  provisionFixtures,
  teardownFixtures,
  warmFunctions,
} from "./helpers/stack";

/**
 * A failed upload-URL mint must never leave a LIVE material behind.
 *
 * marketing-material-file-url creates the row and writes its file_key BEFORE
 * it asks Storage to sign the upload. Until 9 Oct 2026 a signing failure
 * returned 500 and left that row live: on dev, where the marketing bucket was
 * missing, every attempted upload produced a material that looked complete in
 * every rep's library and answered "Object not found" when opened.
 *
 * The failure is produced the way it happened on dev — by taking the bucket
 * away. Live files run one at a time (fileParallelism: false), so no other
 * file is signing into it meanwhile, and the bucket is put back in `finally`
 * exactly as migration 20261009170000 creates it.
 */

let fx: Fixtures;
const TITLE = "LIVE signing-failure material";

beforeAll(async () => {
  if (!(await functionsAreServed())) {
    throw new Error(
      "No Edge Function runtime answering on the local stack.\n" +
        "Run `npx supabase start` and `npx supabase functions serve` first.",
    );
  }
  await warmFunctions(["marketing-material-file-url"]);
  fx = await provisionFixtures();
});

afterAll(async () => {
  // teardownFixtures removes materials uploaded by the personas.
  await teardownFixtures();
});

describe("signing the upload URL fails", () => {
  it("archives the new row rather than leaving it live with a file_key", async () => {
    const admin = adminClient();

    const { error: emptyError } = await admin.storage.emptyBucket(MARKETING_BUCKET);
    expect(emptyError).toBeNull();
    const { error: deleteError } = await admin.storage.deleteBucket(MARKETING_BUCKET);
    expect(deleteError).toBeNull();

    try {
      const { status, body } = await invoke(
        "marketing-material-file-url",
        {
          category: "Rate cards",
          title: TITLE,
          file_name: "sheet.txt",
          mime_type: "text/plain",
        },
        fx.tokens.admin,
      );
      expect(status).toBe(500);
      expect(String(body.error)).toMatch(/Could not create upload URL/);

      const { data: rows, error } = await admin
        .from("marketing_materials")
        .select("id, file_key, archived_at")
        .eq("title", TITLE);
      expect(error).toBeNull();
      expect(rows).toHaveLength(1);
      // It got as far as signing — the key was written — which is the case
      // that used to leave a live dead row.
      expect(rows![0].file_key).toMatch(new RegExp(`^${rows![0].id}/`));
      expect(
        rows![0].archived_at,
        "a material whose upload URL was never minted is still live",
      ).not.toBeNull();
    } finally {
      const { error: restoreError } = await admin.storage.createBucket(
        MARKETING_BUCKET,
        { public: false, fileSizeLimit: 50 * 1024 * 1024 },
      );
      if (restoreError) {
        throw new Error(`could not restore the marketing bucket: ${restoreError.message}`);
      }
    }
  });
});
