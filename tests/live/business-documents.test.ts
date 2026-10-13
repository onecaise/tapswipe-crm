// Real invocations of business-document-file-url, and real PostgREST writes to
// business_documents, against a running local stack (`supabase start` +
// `supabase functions serve`).
//
// Run with:  npm run test:live
//
// tests/rls/business-documents.test.ts proves what the policies do. What only
// this file can prove is the Deno handler's half: its two modes have DIFFERENT
// authorization (an admin uploads, every active rep reads), it refuses a
// deleted document to everyone, and a rep cannot get around the UI by calling
// the function or PostgREST directly. Every success path puts real bytes
// through Storage and reads them back, because a URL that mints and then
// cannot be read is the failure mode worth catching.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type Fixtures,
  BUSINESS_DOCUMENTS_BUCKET,
  adminClient,
  skipWhenFunctionsDown,
  invoke,
  provisionFixtures,
  teardownFixtures,
  toReachableUrl,
  userClient,
  warmFunctions,
} from "./helpers/stack";

const FN = "business-document-file-url";

let fx: Fixtures;

/** True only when functions are down and ALLOW_SKIPPED_FUNCTION_TESTS=1: every test here then skips. */
const FUNCTIONS_DOWN = skipWhenFunctionsDown();

beforeAll(async () => {
  // The run-level gate (tests/live/helpers/global-setup.ts) has already
  // failed the run if the functions runtime is down, unless the opt-in is set.
  if (FUNCTIONS_DOWN) return;
  // A cold serve restarts a function's runtime on its first invocation and
  // 502s whatever is in flight. See warmFunctions().
  await warmFunctions([FN]);
  fx = await provisionFixtures();
});

afterAll(async () => {
  // teardownFixtures -> clearBusinessDocuments removes every row the admin
  // persona uploaded and the objects behind them.
  await teardownFixtures();
});

function report(label: string, status: number, body: unknown): void {
  console.log(`  ${label} -> ${status} ${JSON.stringify(body)}`);
}

/** Publishes a document as the admin, with real bytes behind it. */
async function publish(
  title: string,
  body: string,
  fileName = "policy.txt",
  mimeType = "text/plain",
): Promise<{ documentId: number; fileKey: string }> {
  const { status, body: minted } = await invoke(
    FN,
    {
      category: "Policies",
      title,
      file_name: fileName,
      mime_type: mimeType,
      size_bytes: body.length,
    },
    fx.tokens.admin,
  );
  expect(status).toBe(200);

  const put = await fetch(toReachableUrl(minted.signedUrl as string), {
    method: "PUT",
    headers: {
      "Content-Type": mimeType,
      Authorization: `Bearer ${minted.token}`,
      "x-upsert": "true",
    },
    body,
  });
  expect(put.ok).toBe(true);

  return {
    documentId: minted.document_id as number,
    fileKey: minted.fileKey as string,
  };
}

/** Reads the bytes back through a signed URL minted for `token`. */
async function readAs(
  token: string,
  documentId: number,
  download = false,
): Promise<{ status: number; body: Record<string, unknown>; text?: string }> {
  const { status, body } = await invoke(FN, { document_id: documentId, download }, token);
  if (status !== 200) return { status, body };
  const got = await fetch(toReachableUrl(body.signedUrl as string));
  return { status, body, text: await got.text() };
}

describe("an admin adds, renames and deletes", () => {
  it("adds: mints an upload keyed by document id, records size, and audits it", async () => {
    const { status, body } = await invoke(
      FN,
      {
        category: "Policies",
        title: "Chargeback policy",
        file_name: "chargeback policy.pdf",
        mime_type: "application/pdf",
        size_bytes: 4096,
      },
      fx.tokens.admin,
    );
    report("admin mints upload", status, body);
    expect(status).toBe(200);

    const id = body.document_id as number;
    // Sanitised, so a space never reaches a storage path.
    expect(body.fileKey).toBe(`${id}/chargeback_policy.pdf`);

    const { data: row } = await adminClient()
      .from("business_documents")
      .select("file_key, size_bytes, uploaded_by, archived_at")
      .eq("id", id)
      .single();
    expect(row).toEqual({
      file_key: `${id}/chargeback_policy.pdf`,
      size_bytes: 4096,
      uploaded_by: fx.userIds.admin,
      archived_at: null,
    });

    const { data: audit } = await adminClient()
      .from("audit_log")
      .select("actor_id, action, table_name, row_id")
      .eq("action", "upload_business_document")
      .eq("row_id", String(id));
    expect(audit).toEqual([
      {
        actor_id: fx.userIds.admin,
        action: "upload_business_document",
        table_name: "business_documents",
        row_id: String(id),
      },
    ]);
  });

  it("renames and recategorises through PostgREST", async () => {
    const { documentId } = await publish("Refund policy", "refunds");
    const admin = userClient(fx.tokens.admin);

    const { error } = await admin
      .from("business_documents")
      .update({ title: "Refunds and returns", category: "Procedures" })
      .eq("id", documentId);
    expect(error).toBeNull();

    const { data } = await admin
      .from("business_documents")
      .select("title, category")
      .eq("id", documentId)
      .single();
    expect(data).toEqual({ title: "Refunds and returns", category: "Procedures" });
  });

  it("deletes: the document disappears for a rep and is signed for nobody", async () => {
    const { documentId } = await publish("Retired form", "retired");
    expect((await readAs(fx.tokens.owner, documentId)).status).toBe(200);

    // What the manage page's Delete does: an UPDATE of archived_at.
    const { error } = await userClient(fx.tokens.admin)
      .from("business_documents")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", documentId);
    expect(error).toBeNull();

    const { data: repSees } = await userClient(fx.tokens.owner)
      .from("business_documents")
      .select("id")
      .eq("id", documentId);
    expect(repSees).toEqual([]);

    for (const persona of ["owner", "admin"] as const) {
      const read = await readAs(fx.tokens[persona], documentId);
      report(`${persona} reads deleted`, read.status, read.body);
      expect(read.status).toBe(404);
      expect(read.body.error).toBe("Document not found");
    }
  });
});

describe("every active rep views and downloads", () => {
  it("lets a REP view a document an admin published", async () => {
    // The assertion this function's download branch exists for. Copying an
    // admin-only function wholesale would make the library invisible to reps
    // with no policy failing.
    const { documentId } = await publish("Rep readable", "rep can read this");
    const read = await readAs(fx.tokens.owner, documentId);
    report("rep views", read.status, read.body);
    expect(read.status).toBe(200);
    expect(read.body.disposition).toBe("inline");
    expect(read.text).toBe("rep can read this");
  });

  it("lets a SECOND rep download the same document as an attachment", async () => {
    const { documentId } = await publish("Shared", "shared bytes");
    const read = await invoke(
      FN,
      { document_id: documentId, download: true },
      fx.tokens.intruder,
    );
    report("second rep downloads", read.status, read.body);
    expect(read.status).toBe(200);
    expect(read.body.disposition).toBe("attachment");

    const got = await fetch(toReachableUrl(read.body.signedUrl as string));
    expect(got.headers.get("content-disposition")).toMatch(
      /^attachment; filename=policy\.txt/i,
    );
    expect(await got.text()).toBe("shared bytes");
  });

  it("forces an attachment for a type outside the inline allow-list", async () => {
    // An SVG or HTML file rendering inline would run on the storage origin
    // with a live opener back to the CRM tab.
    const { documentId } = await publish(
      "Diagram",
      "<svg xmlns='http://www.w3.org/2000/svg'/>",
      "diagram.svg",
      "image/svg+xml",
    );
    const read = await invoke(FN, { document_id: documentId }, fx.tokens.owner);
    expect(read.status).toBe(200);
    expect(read.body.disposition).toBe("attachment");
  });

  it("lets every active rep list the library over PostgREST", async () => {
    await publish("Listed", "listed");
    for (const persona of ["owner", "intruder", "admin"] as const) {
      const { data, error } = await userClient(fx.tokens[persona])
        .from("business_documents")
        .select("id")
        .limit(1);
      expect(error).toBeNull();
      expect((data ?? []).length).toBe(1);
    }
  });

  it("refuses a deactivated rep", async () => {
    const { documentId } = await publish("Post-exit", "post-exit");
    const read = await invoke(FN, { document_id: documentId }, fx.tokens.deactivated);
    report("deactivated reads", read.status, read.body);
    expect(read.status).toBe(403);
    expect(read.body.error).toBe("Account is not active");
  });

  it("refuses an unauthenticated caller", async () => {
    const { documentId } = await publish("Anon", "nope");
    const { status } = await invoke(FN, { document_id: documentId });
    expect(status).toBe(401);
  });
});

describe("a rep cannot add or delete by going around the UI", () => {
  it("refuses a rep minting an upload by calling the function directly", async () => {
    const { status, body } = await invoke(
      FN,
      { category: "Policies", title: "Forged", file_name: "x.pdf" },
      fx.tokens.owner,
    );
    report("rep mints upload", status, body);
    expect(status).toBe(403);
    expect(body.error).toBe("Admin only");

    // And it created nothing: the refusal comes before the insert.
    const { data } = await adminClient()
      .from("business_documents")
      .select("id")
      .eq("title", "Forged");
    expect(data).toEqual([]);
  });

  it("refuses a rep inserting a row through PostgREST", async () => {
    const { error } = await userClient(fx.tokens.owner)
      .from("business_documents")
      .insert({ category: "Policies", title: "Rep forged", uploaded_by: fx.userIds.owner });
    report("rep inserts row", error ? 403 : 201, { error: error?.message ?? null });
    expect(error?.message).toMatch(/row-level security/i);
  });

  it("refuses a rep deleting or renaming through PostgREST", async () => {
    const { documentId } = await publish("Keep me", "keep");
    const rep = userClient(fx.tokens.owner);

    // UPDATE is filtered by RLS to zero rows (no error), so the claim is on
    // the data afterwards.
    await rep
      .from("business_documents")
      .update({ archived_at: new Date().toISOString(), title: "Hijacked" })
      .eq("id", documentId);

    // DELETE is refused outright: no grant for it in either role.
    const { error: deleteError } = await rep
      .from("business_documents")
      .delete()
      .eq("id", documentId);
    report("rep deletes row", deleteError ? 403 : 200, {
      error: deleteError?.message ?? null,
    });
    expect(deleteError?.message).toMatch(/permission denied/i);

    const { data } = await adminClient()
      .from("business_documents")
      .select("title, archived_at")
      .eq("id", documentId)
      .single();
    expect(data).toEqual({ title: "Keep me", archived_at: null });
  });

  it("refuses a rep uploading straight into the bucket", async () => {
    // No storage policy exists on the bucket, so a signed upload URL is the
    // only way in, and only the admin branch mints one.
    const { error } = await userClient(fx.tokens.owner)
      .storage.from(BUSINESS_DOCUMENTS_BUCKET)
      .upload(`999999/forged.txt`, new Blob(["forged"]), { contentType: "text/plain" });
    report("rep uploads to bucket", error ? 403 : 200, { error: error?.message ?? null });
    expect(error).not.toBeNull();
  });
});

describe("error paths", () => {
  it("refuses a deactivated admin before it says 'admin only'", async () => {
    const { status, body } = await invoke(
      FN,
      { category: "Policies", title: "Forged", file_name: "x.pdf" },
      fx.tokens.deactivated,
    );
    expect(status).toBe(403);
    expect(body.error).toBe("Account is not active");
  });

  it("rejects a missing category, title or file name", async () => {
    for (const payload of [
      { title: "No category", file_name: "x.pdf" },
      { category: "Policies", file_name: "x.pdf" },
      { category: "Policies", title: "   ", file_name: "x.pdf" },
      { category: "Policies", title: "No file" },
    ]) {
      const { status } = await invoke(FN, payload, fx.tokens.admin);
      expect(status, JSON.stringify(payload)).toBe(400);
    }
  });

  it("404s a document id that does not exist", async () => {
    const { status, body } = await invoke(FN, { document_id: 987654 }, fx.tokens.admin);
    expect(status).toBe(404);
    expect(body.error).toBe("Document not found");
  });

  it("409s a document whose upload never finished", async () => {
    const { data: created } = await adminClient()
      .from("business_documents")
      .insert({
        category: "Policies",
        title: "Never uploaded",
        file_name: "ghost.pdf",
        uploaded_by: fx.userIds.admin,
      })
      .select("id")
      .single();

    const { status, body } = await invoke(FN, { document_id: created!.id }, fx.tokens.admin);
    expect(status).toBe(409);
    expect(body.error).toBe("Document has no file yet");
  });

  it("rejects a non-integer document_id", async () => {
    const { status } = await invoke(
      FN,
      { document_id: "1; drop table business_documents" },
      fx.tokens.admin,
    );
    expect(status).toBe(400);
  });

  it("drops a nonsense size rather than refusing the upload", async () => {
    const { status, body } = await invoke(
      FN,
      { category: "Policies", title: "Odd size", file_name: "odd.txt", size_bytes: -5 },
      fx.tokens.admin,
    );
    expect(status).toBe(200);
    const { data } = await adminClient()
      .from("business_documents")
      .select("size_bytes")
      .eq("id", body.document_id as number)
      .single();
    expect(data?.size_bytes).toBeNull();
  });
});

describe("the stored file_key is never trusted", () => {
  it("refuses a key that does not match its document, at the database", async () => {
    const victim = await publish("Victim", "victim bytes");
    const attacker = await publish("Attacker", "attacker bytes");

    const { error } = await adminClient()
      .from("business_documents")
      .update({ file_key: victim.fileKey })
      .eq("id", attacker.documentId);
    expect(error?.message).toMatch(/business_documents_file_key_matches_id/);

    const read = await readAs(fx.tokens.admin, attacker.documentId);
    expect(read.text).toBe("attacker bytes");
  });
});
