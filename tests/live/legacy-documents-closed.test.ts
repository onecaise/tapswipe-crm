// The legacy per-record documents path is CLOSED, proved over real HTTP
// against the local stack (`supabase start` + `supabase functions serve`).
//
// Run with:  npm run test:live
//
// tests/rls/documents.test.ts proves what migration 20261013121000 does to the
// grants and policies. What only this file can prove is that a rep holding a
// real JWT has no way back in from outside the UI: not through the three
// functions that used to sign uploads and downloads (removed from the repo, so
// the local runtime answers 404 for each slug), not through PostgREST, and not
// straight into the bucket.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type Fixtures,
  BUCKET,
  adminClient,
  skipWhenFunctionsDown,
  invoke,
  provisionFixtures,
  teardownFixtures,
  userClient,
} from "./helpers/stack";

let fx: Fixtures;
let legacyDocumentId = 0;
let legacyFileKey = "";

const REMOVED_FUNCTIONS = [
  "create-upload-url",
  "create-download-url",
  "delete-document",
] as const;

/** True only when functions are down and ALLOW_SKIPPED_FUNCTION_TESTS=1: every test here then skips. */
const FUNCTIONS_DOWN = skipWhenFunctionsDown();

beforeAll(async () => {
  // The run-level gate (tests/live/helpers/global-setup.ts) has already
  // failed the run if the functions runtime is down, unless the opt-in is set.
  if (FUNCTIONS_DOWN) return;
  fx = await provisionFixtures();

  // One legacy row and object filed under the owner, written the only way
  // anything can write them now: as the service role. This is the state a
  // hosted project is in until scripts/purge-legacy-documents.mjs runs.
  const admin = adminClient();
  legacyFileKey = `${fx.userIds.owner}/merchant/${fx.ownerIds.owner.merchant}/legacy-check`;
  const { error: uploadError } = await admin.storage
    .from(BUCKET)
    .upload(legacyFileKey, new Blob(["legacy bytes"]), {
      contentType: "application/pdf",
      upsert: true,
    });
  if (uploadError) throw new Error(`legacy object: ${uploadError.message}`);

  const { data, error } = await admin
    .from("documents")
    .insert({
      agent_id: fx.userIds.owner,
      owner_type: "merchant",
      owner_id: fx.ownerIds.owner.merchant,
      doc_type: "Voided check",
      file_key: legacyFileKey,
      file_name: "legacy-check.pdf",
      mime_type: "application/pdf",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`legacy row: ${error?.message}`);
  legacyDocumentId = data.id as number;
});

afterAll(async () => {
  // teardownFixtures deletes documents by agent_id and sweeps the owner's
  // objects in the legacy bucket.
  await teardownFixtures();
});

function report(label: string, status: number, body: unknown): void {
  console.log(`  ${label} -> ${status} ${JSON.stringify(body)}`);
}

describe("the three legacy functions are gone", () => {
  for (const name of REMOVED_FUNCTIONS) {
    it(`${name} answers 404 to a signed-in rep`, async () => {
      // 404 is the runtime saying the slug does not exist. A function that
      // still existed would answer with its own 4xx/2xx -- the contrast
      // CLAUDE.md records for checking a deploy.
      const { status, raw } = await invoke(
        name,
        {
          owner_type: "merchant",
          owner_id: fx.ownerIds.owner.merchant,
          file_name: "check.pdf",
          document_id: legacyDocumentId,
        },
        fx.tokens.owner,
      );
      report(`${name}`, status, raw.slice(0, 120));
      expect(status).toBe(404);
    });
  }
});

describe("PostgREST refuses every legacy write, and hides every legacy row from a rep", () => {
  it("refuses a rep inserting a document row", async () => {
    const { error } = await userClient(fx.tokens.owner)
      .from("documents")
      .insert({
        agent_id: fx.userIds.owner,
        owner_type: "merchant",
        owner_id: fx.ownerIds.owner.merchant,
        doc_type: "Voided check",
        file_key: `${fx.userIds.owner}/merchant/${fx.ownerIds.owner.merchant}/new-upload`,
        file_name: "new.pdf",
      });
    report("rep inserts documents row", error ? 403 : 201, {
      error: error?.message ?? null,
    });
    expect(error?.message).toMatch(/permission denied/i);
  });

  it("refuses a rep deleting their own legacy row", async () => {
    const { error } = await userClient(fx.tokens.owner)
      .from("documents")
      .delete()
      .eq("id", legacyDocumentId);
    report("rep deletes own documents row", error ? 403 : 200, {
      error: error?.message ?? null,
    });
    expect(error?.message).toMatch(/permission denied/i);

    const { data } = await adminClient()
      .from("documents")
      .select("id")
      .eq("id", legacyDocumentId);
    expect(data).toHaveLength(1);
  });

  it("refuses an admin inserting too", async () => {
    const { error } = await userClient(fx.tokens.admin)
      .from("documents")
      .insert({
        agent_id: fx.userIds.owner,
        owner_type: "merchant",
        owner_id: fx.ownerIds.owner.merchant,
        doc_type: "Voided check",
        file_key: `${fx.userIds.owner}/merchant/${fx.ownerIds.owner.merchant}/admin-upload`,
      });
    expect(error?.message).toMatch(/permission denied/i);
  });

  it("shows a rep none of the rows, including their own", async () => {
    const { data, error } = await userClient(fx.tokens.owner)
      .from("documents")
      .select("id");
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("still shows an admin what is left until the purge", async () => {
    const { data, error } = await userClient(fx.tokens.admin)
      .from("documents")
      .select("id")
      .eq("id", legacyDocumentId);
    expect(error).toBeNull();
    expect(data).toEqual([{ id: legacyDocumentId }]);
  });
});

describe("the legacy bucket refuses a rep directly", () => {
  it("refuses a rep uploading straight into it", async () => {
    const { error } = await userClient(fx.tokens.owner)
      .storage.from(BUCKET)
      .upload(
        `${fx.userIds.owner}/merchant/${fx.ownerIds.owner.merchant}/direct`,
        new Blob(["direct"]),
        { contentType: "application/pdf" },
      );
    report("rep uploads to documents bucket", error ? 403 : 200, {
      error: error?.message ?? null,
    });
    expect(error).not.toBeNull();
  });

  it("refuses a rep reading their own legacy object directly", async () => {
    const { data, error } = await userClient(fx.tokens.owner)
      .storage.from(BUCKET)
      .download(legacyFileKey);
    report("rep downloads from documents bucket", error ? 400 : 200, {
      error: error?.message ?? null,
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });
});
